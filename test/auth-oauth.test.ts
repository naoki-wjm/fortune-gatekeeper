/**
 * OAuth の門（`POST /astro/mcp`）まわりの検算。
 *
 * `@cloudflare/workers-oauth-provider` そのもの（トークン発行・Access との往復）はここでは試しません
 * ―― `cloudflare:workers` を読むので Node では動かないうえ、確かめたいのは接合部だからです。
 * 見るのは 3 つ:
 *   - 許可台帳（`email:<SHA-256>`）の照合＝ `hashEmail` / `lookupEmail`
 *   - 認証済みリクエストの受け口＝ 誰を通すか、何を占星術層に渡すか
 *   - `defaultHandler` ＝ OAuth の面以外が今までどおりのルーターに落ちること
 *
 * ⚠ メールアドレスは全部この場の作りごと（example.com）です。実在のものは書きません。
 */
import { beforeEach, describe, expect, it } from "vitest";
import { ASTRO_TOOLS, handleAstroMcpRequest, type AstroContext } from "../src/astro/astro-mcp";
import { TOOLS as CARD_TOOLS } from "../src/mcp";
import { hashEmail, lookupEmail, type AuthContext } from "../src/astro/store";
import {
  createAstroOAuthHandler,
  defaultHandler,
  type AuthEnvWithOauth,
  type ExecutionContextWithProps,
} from "../src/auth/oauth";
import { FakeKv } from "./stubs/fake-kv";
import { makeFakeEngine, type FakeEngine } from "./stubs/fake-engine";

/** 台帳に載っている人（作りごとのアドレス） */
const MEMBER_EMAIL = "hoshi@example.com";
/**
 * 既知のベクタ: SHA-256("hoshi@example.com") の hex 小文字。
 * この値は実装とは別の道具（.NET の SHA256 / node:crypto）で出して突き合わせたものです。
 */
const MEMBER_HASH = "b3e854aef8183a3950a127e42b12931ee503b0710080d25e11db461665a1cf1a";
const MEMBER_RECORD = JSON.stringify({ user: "user1", name: "オーナー", role: "owner" });

/** 台帳に載っていない人 */
const STRANGER_EMAIL = "yobarete-nai@example.com";

let kv: FakeKv;
let engine: FakeEngine;

beforeEach(() => {
  kv = new FakeKv();
  kv.store.set(`email:${MEMBER_HASH}`, MEMBER_RECORD);
  engine = makeFakeEngine();
});

/** Workers から渡ってくる env の代わり（OAUTH_PROVIDER は defaultHandler のときだけ差す） */
function envWith(extra: Record<string, unknown> = {}): AuthEnvWithOauth {
  return { ASTRO_KV: kv.asKvNamespace(), ...extra } as unknown as AuthEnvWithOauth;
}

/** props（＝ Access で確かめた身元）つきの ExecutionContext の代わり */
function ctxWith(props?: { email?: string }): ExecutionContextWithProps {
  return (props ? { props } : {}) as unknown as ExecutionContextWithProps;
}

const NO_CTX = {} as unknown as ExecutionContext;

/** OAuth の口に JSON-RPC を 1 発投げる */
async function postAstro(
  body: unknown,
  options: { email?: string; method?: string } = {},
): Promise<{ response: Response; text: string; json: any }> {
  const handler = createAstroOAuthHandler({ getEngine: async () => engine });
  const method = options.method ?? "POST";
  const init: RequestInit = { method, headers: { "Content-Type": "application/json" } };
  if (method === "POST") init.body = JSON.stringify(body);

  const response = await handler.fetch(
    new Request("http://localhost/astro/mcp", init),
    envWith(),
    ctxWith(options.email === undefined ? undefined : { email: options.email }),
  );
  const text = await response.text();
  let json: any = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = null;
  }
  return { response, text, json };
}

// ---------------------------------------------------------------------------
// 許可台帳（email:<SHA-256>）
// ---------------------------------------------------------------------------

describe("hashEmail", () => {
  it("既知のベクタと一致する", async () => {
    expect(await hashEmail(MEMBER_EMAIL)).toBe(MEMBER_HASH);
  });

  it("前後の空白と大文字小文字をそろえてから掛ける", async () => {
    expect(await hashEmail("  Hoshi@Example.COM \n")).toBe(MEMBER_HASH);
  });

  it("別のアドレスは別のハッシュになる", async () => {
    expect(await hashEmail(STRANGER_EMAIL)).not.toBe(MEMBER_HASH);
  });
});

describe("lookupEmail", () => {
  it("台帳に載っていれば AuthContext を返す", async () => {
    const auth = await lookupEmail(kv, MEMBER_EMAIL);
    expect(auth).toEqual({ user: "user1", name: "オーナー", role: "owner" });
  });

  it("大文字・前後の空白つきでも同じレコードを引く", async () => {
    const auth = await lookupEmail(kv, "  HOSHI@example.com  ");
    expect(auth?.user).toBe("user1");
  });

  it("載っていなければ null", async () => {
    expect(await lookupEmail(kv, STRANGER_EMAIL)).toBeNull();
  });

  it("メールの形をしていなければ null", async () => {
    expect(await lookupEmail(kv, "")).toBeNull();
    expect(await lookupEmail(kv, "   ")).toBeNull();
    expect(await lookupEmail(kv, "hoshi")).toBeNull();
  });

  it("壊れたレコードは載っていない扱い", async () => {
    const broken = ["これは JSON ではありません", "null", "[]"];
    for (const raw of broken) {
      kv.store.set(`email:${MEMBER_HASH}`, raw);
      expect(await lookupEmail(kv, MEMBER_EMAIL)).toBeNull();
    }
  });

  it("role が owner / friend 以外、user が空や : つきなら通さない", async () => {
    const bad = [
      JSON.stringify({ user: "user1", role: "admin" }),
      JSON.stringify({ user: "", role: "owner" }),
      JSON.stringify({ user: "chart:user1", role: "owner" }),
      JSON.stringify({ role: "owner" }),
    ];
    for (const raw of bad) {
      kv.store.set(`email:${MEMBER_HASH}`, raw);
      expect(await lookupEmail(kv, MEMBER_EMAIL)).toBeNull();
    }
  });

  it("name が無ければ user を名前に使う（鍵のときと同じ扱い）", async () => {
    kv.store.set(`email:${MEMBER_HASH}`, JSON.stringify({ user: "user1", role: "friend" }));
    expect(await lookupEmail(kv, MEMBER_EMAIL)).toEqual({
      user: "user1",
      name: "user1",
      role: "friend",
    });
  });
});

// ---------------------------------------------------------------------------
// 認証済みリクエストの受け口（apiHandler）
// ---------------------------------------------------------------------------

describe("OAuth の口（POST /astro/mcp）", () => {
  it("身元（ctx.props）が無ければ 403", async () => {
    const { response, json } = await postAstro({ jsonrpc: "2.0", id: 1, method: "tools/list" });
    expect(response.status).toBe(403);
    expect(json.error.message).toContain("身元の確認");
  });

  it("台帳に無いメールは 403（返事にアドレスを出さない）", async () => {
    const { response, text, json } = await postAstro(
      { jsonrpc: "2.0", id: 1, method: "tools/list" },
      { email: STRANGER_EMAIL },
    );
    expect(response.status).toBe(403);
    expect(json.error.message).toContain("台帳");
    expect(text).not.toContain(STRANGER_EMAIL);
    expect(text).not.toContain("example.com");
  });

  it("台帳にあるメールなら占星術層の tools/list が返る", async () => {
    const { response, json } = await postAstro(
      { jsonrpc: "2.0", id: 1, method: "tools/list" },
      { email: MEMBER_EMAIL },
    );
    expect(response.status).toBe(200);
    // 2026-08-24 のスーパーセット化で、この入口には占星術層＋カード層の全 24 本が並ぶ
    expect(json.result.tools.map((tool: { name: string }) => tool.name)).toEqual(
      [...ASTRO_TOOLS, ...CARD_TOOLS].map((tool) => tool.name),
    );
  });

  it("大文字・空白つきのメールでも通る（台帳と同じ正規化）", async () => {
    const { response } = await postAstro(
      { jsonrpc: "2.0", id: 1, method: "tools/list" },
      { email: " Hoshi@Example.com " },
    );
    expect(response.status).toBe(200);
  });

  it("POST 以外は 405", async () => {
    const { response, json } = await postAstro(null, { email: MEMBER_EMAIL, method: "GET" });
    expect(response.status).toBe(405);
    expect(json.error.message).toContain("POST /astro/mcp");
  });

  it("台帳（KV）が無ければ 500 と正直に言う", async () => {
    const handler = createAstroOAuthHandler({ getEngine: async () => engine });
    const response = await handler.fetch(
      new Request("http://localhost/astro/mcp", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
      }),
      {} as unknown as AuthEnvWithOauth,
      ctxWith({ email: MEMBER_EMAIL }),
    );
    expect(response.status).toBe(500);
  });

  it("門のトークン（authorization）と cookie は占星術層に渡さない", async () => {
    let seen: Request | null = null;
    let context: AstroContext | null = null;
    const handler = createAstroOAuthHandler({
      getEngine: async () => engine,
      handle: async (request, ctx) => {
        seen = request;
        context = ctx;
        return new Response("ok");
      },
    });

    const original = new Request("http://localhost/astro/mcp", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer secret-token",
        Cookie: "session=abc",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });
    // 落とす前に、確かに載っていることを見ておく（載っていなければこのテストは何も守れない）
    expect(original.headers.get("authorization")).toBe("Bearer secret-token");
    expect(original.headers.get("cookie")).toBe("session=abc");

    await handler.fetch(original, envWith(), ctxWith({ email: MEMBER_EMAIL }));

    const forwarded = seen as Request | null;
    expect(forwarded).not.toBeNull();
    expect(forwarded?.headers.get("authorization")).toBeNull();
    expect(forwarded?.headers.get("cookie")).toBeNull();
    // 中身（JSON-RPC の本体）はそのまま渡っている
    expect(await forwarded?.json()).toEqual({ jsonrpc: "2.0", id: 1, method: "tools/list" });
    // 渡す AuthContext は台帳のレコードそのまま（メールは持ち込まない）
    expect(context).not.toBeNull();
    expect((context as unknown as AstroContext).auth).toEqual({
      user: "user1",
      name: "オーナー",
      role: "owner",
    });
    expect(JSON.stringify((context as unknown as AstroContext).auth)).not.toContain("@");
  });

  it("台帳の user がチャートの仕切り（同じ user なら同じチャート台帳が見える）", async () => {
    // OAuth の口から 1 件登録して……
    const saved = await postAstro(
      {
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: {
          name: "save_chart",
          arguments: {
            label: "OAuth から登録",
            year: 1990,
            month: 6,
            day: 15,
            hour: 12,
            minute: 0,
            utc_offset: 0,
            lat: 35.6895,
            lng: 139.6917,
          },
        },
      },
      { email: MEMBER_EMAIL },
    );
    expect(saved.json.result.isError).toBeUndefined();
    const chartId = saved.json.result.structuredContent.chart_id as string;

    // ……台帳から引いた同じ AuthContext（user1）で一覧に出る
    const auth = (await lookupEmail(kv, MEMBER_EMAIL)) as AuthContext;
    expect(auth.user).toBe("user1");
    const context: AstroContext = { auth, kv, getEngine: async () => engine };
    const response = await handleAstroMcpRequest(
      new Request("http://localhost/astro/mcp", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "list_charts", arguments: {} } }),
      }),
      context,
    );
    const listed = JSON.parse(await response.text());
    const ids = listed.result.structuredContent.charts.map((c: { chart_id: string }) => c.chart_id);
    expect(ids).toContain(chartId);
  });
});

// ---------------------------------------------------------------------------
// defaultHandler（OAuth の面以外は今までどおり）
// ---------------------------------------------------------------------------

describe("defaultHandler", () => {
  async function through(
    path: string,
    body: unknown = null,
    method = "POST",
    extraEnv: Record<string, unknown> = {},
  ): Promise<{ response: Response; text: string }> {
    const init: RequestInit = { method };
    if (method === "POST") {
      init.headers = { "Content-Type": "application/json" };
      init.body = JSON.stringify(body);
    }
    const response = await defaultHandler.fetch(
      new Request(`http://localhost${path}`, init),
      envWith(extraEnv),
      NO_CTX,
    );
    return { response, text: await response.text() };
  }

  it("カード層（POST /mcp）はそのまま届く", async () => {
    const { response, text } = await through("/mcp", {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/list",
    });
    expect(response.status).toBe(200);
    const names = JSON.parse(text).result.tools.map((tool: { name: string }) => tool.name);
    expect(names).toContain("draw_cards");
  });

  // 2026-08-22 URL 鍵の引退。占星術層は apiRoute（/astro/mcp）の内側だけになったので、
  //            ルーターに落ちる /mcp/<何か> はただの 404
  it("/mcp のあとに何か続く URL は 404（鍵の口はもう無い）", async () => {
    const { response, text } = await through("/mcp/nosuchkey0000000000", {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/list",
    });
    expect(response.status).toBe(404);
    expect(text).not.toContain("nosuchkey");
  });

  it("案内文と /health もそのまま", async () => {
    const guide = await through("/", null, "GET");
    expect(guide.response.status).toBe(200);
    expect(guide.text).toContain("fortune-gatekeeper");

    const health = await through("/health", null, "GET");
    expect(health.text).toBe("ok");
  });

  it("/authorize は OAuth の受付（access-handler）に渡る", async () => {
    // clientId が空なら access-handler は 400 を返す＝ルーターの 404 ではないことの証拠
    const { response, text } = await through("/authorize", null, "GET", {
      OAUTH_PROVIDER: { parseAuthRequest: async () => ({ clientId: "" }) },
    });
    expect(response.status).toBe(400);
    expect(text).not.toContain("見つかりません");
  });

  // 2026-08-27 workers-oauth-provider 0.10 から parseAuthRequest は認可要求の不備を
  //            AuthorizationError で投げる（PKCE なし・plain など）。500 に倒さず OAuth の作法で断る
  function authorizationError(extra: Record<string, unknown>): Error {
    const error = new Error("Public clients must use PKCE with the authorization code flow.");
    error.name = "AuthorizationError";
    return Object.assign(error, {
      code: "invalid_request",
      description: error.message,
      ...extra,
    });
  }

  it("/authorize: 認可要求の不備で redirect_uri の照合が済んでいればエラーリダイレクト", async () => {
    const { response } = await through("/authorize", null, "GET", {
      OAUTH_PROVIDER: {
        parseAuthRequest: async () => {
          throw authorizationError({
            redirectUri: "http://localhost:9999/cb",
            state: "s1",
            issuer: "http://localhost",
          });
        },
      },
    });
    expect(response.status).toBe(302);
    const location = new URL(response.headers.get("Location") ?? "");
    expect(location.origin + location.pathname).toBe("http://localhost:9999/cb");
    expect(location.searchParams.get("error")).toBe("invalid_request");
    expect(location.searchParams.get("error_description")).toContain("PKCE");
    expect(location.searchParams.get("state")).toBe("s1");
    expect(location.searchParams.get("iss")).toBe("http://localhost");
  });

  it("/authorize: 照合前の不備（redirectUri なし）は手元で 400", async () => {
    const { response, text } = await through("/authorize", null, "GET", {
      OAUTH_PROVIDER: {
        parseAuthRequest: async () => {
          throw authorizationError({});
        },
      },
    });
    expect(response.status).toBe(400);
    expect(text).toContain("invalid_request");
    expect(text).toContain("PKCE");
  });

  it("/authorize: AuthorizationError 以外の例外は握りつぶさない", async () => {
    await expect(
      through("/authorize", null, "GET", {
        OAUTH_PROVIDER: {
          parseAuthRequest: async () => {
            throw new Error("kv down");
          },
        },
      }),
    ).rejects.toThrow("kv down");
  });

  it("/callback もルーターには落ちず、OAuth の作法でエラーを返す", async () => {
    // state を持たない生の GET なので access-handler が invalid_request を返す
    // ＝ルーターの 404（案内文）ではないことの証拠
    const { response, text } = await through("/callback", null, "GET", {
      OAUTH_KV: kv.asKvNamespace(),
      COOKIE_ENCRYPTION_KEY: "0".repeat(64),
    });
    expect(response.status).toBe(400);
    expect(JSON.parse(text).error).toBe("invalid_request");
    expect(text).not.toContain("見つかりません");
  });
});
