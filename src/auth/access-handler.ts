import { Buffer } from "node:buffer";
import type { AuthRequest, OAuthHelpers } from "@cloudflare/workers-oauth-provider";
import type { AuthEnv as Env } from "./env";
import {
	addApprovedClient,
	createOAuthState,
	fetchUpstreamAuthToken,
	generateCSRFProtection,
	getUpstreamAuthorizeUrl,
	isClientApproved,
	OAuthError,
	type Props,
	renderApprovalDialog,
	validateCSRFToken,
	validateOAuthState,
} from "./workers-oauth-utils";

type EnvWithOauth = Env & { OAUTH_PROVIDER: OAuthHelpers };

export async function handleAccessRequest(
	request: Request,
	env: EnvWithOauth,
	_ctx: ExecutionContext,
) {
	const { pathname, searchParams } = new URL(request.url);

	if (request.method === "GET" && pathname === "/authorize") {
		let oauthReqInfo: AuthRequest;
		try {
			oauthReqInfo = await env.OAUTH_PROVIDER.parseAuthRequest(request);
		} catch (error) {
			const refusal = authorizationRefusal(error);
			if (refusal) return refusal;
			throw error;
		}
		const { clientId } = oauthReqInfo;
		if (!clientId) {
			return new Response("Invalid request", { status: 400 });
		}

		// Check if client is already approved — no approval form so no CSRF cookie to clear
		if (await isClientApproved(request, clientId, env.COOKIE_ENCRYPTION_KEY)) {
			const { stateToken, codeChallenge } = await createOAuthState(
				oauthReqInfo,
				env.OAUTH_KV,
				env.COOKIE_ENCRYPTION_KEY,
			);
			return redirectToAccess(request, env, stateToken, codeChallenge);
		}

		// Generate CSRF protection for the approval form
		const { token: csrfToken, setCookie } = generateCSRFProtection();

		return renderApprovalDialog(request, {
			client: await env.OAUTH_PROVIDER.lookupClient(clientId),
			csrfToken,
			server: {
				description:
					"占いMCPの占星術層（鍵つき）に、あなたの Cloudflare Access アカウントで接続します。",
				name: "fortune-gatekeeper 占星術層",
			},
			setCookie,
			state: { oauthReqInfo },
		});
	}

	if (request.method === "POST" && pathname === "/authorize") {
		try {
			// Read form data once at top
			const formData = await request.formData();

			// Validate CSRF token and capture clearCookie to expire the one-time-use token
			const csrfResult = validateCSRFToken(formData, request);

			// Extract state from form data
			const encodedState = formData.get("state");
			if (!encodedState || typeof encodedState !== "string") {
				return new Response("Missing state in form data", { status: 400 });
			}

			let state: { oauthReqInfo?: AuthRequest };
			try {
				state = JSON.parse(atob(encodedState));
			} catch (_e) {
				return new Response("Invalid state data", { status: 400 });
			}

			if (!state.oauthReqInfo || !state.oauthReqInfo.clientId) {
				return new Response("Invalid request", { status: 400 });
			}

			// Add client to approved list
			const approvedClientCookie = await addApprovedClient(
				request,
				state.oauthReqInfo.clientId,
				env.COOKIE_ENCRYPTION_KEY,
			);

			// Create OAuth state
			const { stateToken, codeChallenge } = await createOAuthState(
				state.oauthReqInfo,
				env.OAUTH_KV,
				env.COOKIE_ENCRYPTION_KEY,
			);

			// Build redirect headers — use Headers to support multiple Set-Cookie values
			const redirectHeaders = new Headers();
			redirectHeaders.append("Set-Cookie", approvedClientCookie);
			redirectHeaders.append("Set-Cookie", csrfResult.clearCookie);

			return redirectToAccess(request, env, stateToken, codeChallenge, redirectHeaders);
		} catch (error: any) {
			console.error("POST /authorize error:", error);
			if (error instanceof OAuthError) {
				return error.toResponse();
			}
			// Unexpected non-OAuth error
			return new Response(`Internal server error: ${error.message}`, { status: 500 });
		}
	}

	if (request.method === "GET" && pathname === "/callback") {
		// Validate OAuth state (retrieves stored data from KV)
		let oauthReqInfo: AuthRequest;
		let codeVerifier: string;

		try {
			const result = await validateOAuthState(
				request,
				env.OAUTH_KV,
				env.COOKIE_ENCRYPTION_KEY,
			);
			oauthReqInfo = result.oauthReqInfo;
			codeVerifier = result.codeVerifier;
		} catch (error: any) {
			if (error instanceof OAuthError) {
				return error.toResponse();
			}
			// Unexpected non-OAuth error
			return new Response("Internal server error", { status: 500 });
		}

		if (!oauthReqInfo.clientId) {
			return new Response("Invalid OAuth request data", { status: 400 });
		}

		// Exchange the code for an access token, including the PKCE verifier
		const [accessToken, idToken, errResponse] = await fetchUpstreamAuthToken({
			client_id: env.ACCESS_CLIENT_ID,
			client_secret: env.ACCESS_CLIENT_SECRET,
			code: searchParams.get("code") ?? undefined,
			redirect_uri: new URL("/callback", request.url).href,
			upstream_url: env.ACCESS_TOKEN_URL,
			code_verifier: codeVerifier,
		});
		if (errResponse) {
			return errResponse;
		}

		const idTokenClaims = await verifyToken(env, idToken);
		const user = {
			email: idTokenClaims.email,
			name: idTokenClaims.name,
			sub: idTokenClaims.sub,
		};

		// Return back to the MCP client a new token
		const { redirectTo } = await env.OAUTH_PROVIDER.completeAuthorization({
			metadata: {
				label: user.name,
			},
			// This will be available on this.props inside MyMCP
			props: {
				accessToken,
				email: user.email,
				login: user.sub,
				name: user.name,
			} as Props,
			request: oauthReqInfo,
			scope: oauthReqInfo.scope,
			userId: user.sub,
		});

		return Response.redirect(redirectTo, 302);
	}

	return new Response("Not Found", { status: 404 });
}

async function redirectToAccess(
	request: Request,
	env: Env,
	stateToken: string,
	codeChallenge: string,
	extraHeaders: Headers = new Headers(),
) {
	const headers = new Headers(extraHeaders);
	headers.set(
		"location",
		getUpstreamAuthorizeUrl({
			client_id: env.ACCESS_CLIENT_ID,
			code_challenge: codeChallenge,
			redirect_uri: new URL("/callback", request.url).href,
			scope: "openid email profile",
			state: stateToken,
			upstream_url: env.ACCESS_AUTHORIZATION_URL,
		}),
	);
	return new Response(null, { headers, status: 302 });
}

/**
 * `parseAuthRequest()` が投げる `AuthorizationError`（workers-oauth-provider 0.10 から。PKCE なし・
 * plain・未知の response_type など、認可要求そのものの不備）を OAuth の作法で断る。
 * クラスは値 import しない（パッケージが `cloudflare:workers` を読むので Node のテストで動かない）
 * ＝ `name` で見分ける。`redirectUri` を持つ（＝クライアントと redirect_uri の照合が済んだ）ものだけ
 * エラーリダイレクト、それ以外は手元で 400。説明文はライブラリの定型文なのでそのまま添える。
 * 2026-08-27 の 0.10.3 更新で足した手入れ（これが無いと拒否が 500 で返る。手本も未対応）。
 *
 * `redirectUri` は **http / https の URL として読めたときだけ**リダイレクトに使う（2026-08-27 再査読対応）。
 * 読めない文字列だと `new URL()` がそこで投げて 500 になり、`javascript:` のような別の仕組みの
 * URL はそもそもリダイレクト先にしてはいけない ―― どちらも手元で 400 に倒す。
 */
function authorizationRefusal(error: unknown): Response | null {
	if (!(error instanceof Error) || error.name !== "AuthorizationError") {
		return null;
	}
	const { code, description, redirectUri, state, issuer } = error as Error & {
		code?: string;
		description?: string;
		redirectUri?: string;
		state?: string;
		issuer?: string;
	};
	const errorCode = code || "invalid_request";
	const url = httpUrlOrNull(redirectUri);
	if (url) {
		url.searchParams.set("error", errorCode);
		if (description) url.searchParams.set("error_description", description);
		if (state) url.searchParams.set("state", state);
		if (issuer) url.searchParams.set("iss", issuer);
		return Response.redirect(url.href, 302);
	}
	return new Response(`Invalid request: ${errorCode}${description ? ` (${description})` : ""}`, {
		status: 400,
	});
}

/** http / https の URL として読めれば URL、読めなければ（別のスキームでも）null */
function httpUrlOrNull(raw: string | undefined): URL | null {
	if (!raw) return null;
	let url: URL;
	try {
		url = new URL(raw);
	} catch {
		return null;
	}
	return url.protocol === "http:" || url.protocol === "https:" ? url : null;
}

/**
 * Helper to get the Access public keys from the certs endpoint
 */
async function fetchAccessPublicKey(env: Env, kid: string) {
	if (!env.ACCESS_JWKS_URL) {
		throw new Error("access jwks url not provided");
	}
	// TODO: cache this
	const resp = await fetch(env.ACCESS_JWKS_URL);
	if (!resp.ok) {
		throw new Error("failed to fetch access jwks");
	}
	const keys = (await resp.json()) as {
		keys: (JsonWebKey & { kid: string })[];
	};
	const jwk = keys.keys.find((key) => key.kid === kid);
	// 対応する鍵が無ければ明示的に拒否（importKey の偶発的な例外に頼らない）
	if (!jwk || jwk.kty !== "RSA") {
		throw new Error("signing key not found");
	}
	const key = await crypto.subtle.importKey(
		"jwk",
		jwk,
		{
			hash: "SHA-256",
			name: "RSASSA-PKCS1-v1_5",
		},
		false,
		["verify"],
	);
	return key;
}

/**
 * Parse a JWT into its respective pieces. Does not do any validation other than form checking.
 */
function parseJWT(token: string) {
	const tokenParts = token.split(".");

	if (tokenParts.length !== 3) {
		throw new Error("token must have 3 parts");
	}

	return {
		data: `${tokenParts[0]}.${tokenParts[1]}`,
		header: JSON.parse(Buffer.from(tokenParts[0], "base64url").toString()),
		payload: JSON.parse(Buffer.from(tokenParts[1], "base64url").toString()),
		signature: tokenParts[2],
	};
}

/**
 * Validates the provided token using the Access public key set.
 * 署名・exp に加えて alg / kid / iss / aud / nbf / iat / email を確認する（2026-08-22 査読対応）。
 * 期待する issuer は ACCESS_ISSUER（任意）、無ければ ACCESS_TOKEN_URL から /token を外したもの。
 * audience は ACCESS_CLIENT_ID。
 */
const CLOCK_SKEW_SEC = 60;

async function verifyToken(env: Env, token: string) {
	const jwt = parseJWT(token);
	if (jwt.header?.alg !== "RS256") {
		throw new Error("unexpected token alg");
	}
	if (typeof jwt.header?.kid !== "string" || !jwt.header.kid) {
		throw new Error("token kid missing");
	}
	const key = await fetchAccessPublicKey(env, jwt.header.kid);

	const verified = await crypto.subtle.verify(
		"RSASSA-PKCS1-v1_5",
		key,
		Buffer.from(jwt.signature, "base64url"),
		Buffer.from(jwt.data),
	);

	if (!verified) {
		throw new Error("failed to verify token");
	}

	const claims = jwt.payload;
	const now = Math.floor(Date.now() / 1000);
	// 時間系: exp 必須、nbf / iat は在れば確認（±60秒のずれを許容）
	if (typeof claims.exp !== "number" || claims.exp < now - CLOCK_SKEW_SEC) {
		throw new Error("expired token");
	}
	if (typeof claims.nbf === "number" && claims.nbf > now + CLOCK_SKEW_SEC) {
		throw new Error("token not yet valid");
	}
	if (typeof claims.iat === "number" && claims.iat > now + CLOCK_SKEW_SEC) {
		throw new Error("token issued in the future");
	}
	// issuer: この Access アプリ以外のトークンは受けない。
	// Access for SaaS (OIDC) の issuer は https://<team>.cloudflareaccess.com/cdn-cgi/access/sso/oidc/<client_id>
	// ＝ token endpoint から末尾の /token を外したもの（2026-08-22 に discovery で実測）。
	const expectedIss = env.ACCESS_ISSUER || env.ACCESS_TOKEN_URL.replace(/\/token$/, "");
	if (claims.iss !== expectedIss) {
		throw new Error("unexpected token issuer");
	}
	// audience: この OAuth client 向けのトークンだけ（同じ鍵で署名された別アプリ向けを混ぜない）
	const aud = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
	if (!aud.includes(env.ACCESS_CLIENT_ID)) {
		throw new Error("unexpected token audience");
	}
	if (typeof claims.email !== "string" || !claims.email) {
		throw new Error("token has no email claim");
	}

	return claims;
}
