/**
 * 内部障害の言い方をここ 1 か所に固定する（2026-08-27 査読対応）。
 *
 * 既知の入力エラー（AstroError / CastError / DrawError / DiceError / ArgumentError / ShukuyoError）は
 * 「渡された引数が変だった」という言い分なので、そのまま利用者へ返してよい。
 * それ以外の例外 ―― wasm の初期化失敗、KV の障害、配線の思わぬ穴 ―― の `message` や `stack` には
 * 何が混ざっているか分からない（呼び出し引数・chart_id・預かった出生データが載りうる）。
 * なので**利用者には固定文だけ**を返し、中身は表に出さない。
 *
 * `wrangler.jsonc` の invocation_logs は切ってあるが、**明示した console.error は残る**。
 * 参照 ID は運用者がログと突き合わせるための札で、利用者には固定文だけ返す
 * ―― ログにも message・stack・引数は書かない（残すのは参照 ID・種別・例外クラス名の 3 つだけ）。
 */

/**
 * 天体計算エンジン（wasm）の初期化に失敗した、という内部障害型。
 *
 * 既知の入力エラー型（AstroError / CastError）とは別にしてあるのは、
 * 「利用者の指定が変だった」のではなく「サーバー側が立ち上がらなかった」ことを
 * 呼び出し側の catch が見分けられるようにするため。**詳細文は持たせない**。
 */
export class EngineInitError extends Error {
  constructor() {
    super("天体計算エンジンの初期化に失敗しました");
    this.name = "EngineInitError";
  }
}

/** 運用者がログと突き合わせるための札（8 桁の hex） */
function newReferenceId(): string {
  const bytes = new Uint8Array(4);
  crypto.getRandomValues(bytes);
  return Array.from(bytes)
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * 内部障害の固定文を作り、参照 ID だけをログに落とす。
 *
 * ログに書くのは参照 ID・種別・例外クラス名の 3 つだけ
 * （message・stack・引数・chart_id・出生データは一切載せない）。
 */
export function internalFailureMessage(error: unknown, kind: "unexpected" | "engine"): string {
  const referenceId = newReferenceId();
  const errorName = error instanceof Error ? error.name : typeof error;
  console.error({ reference_id: referenceId, kind, error_name: errorName });

  return kind === "engine"
    ? `天体計算エンジンを初期化できませんでした。参照ID: ${referenceId}`
    : `内部処理で予期しないエラーが発生しました。参照ID: ${referenceId}`;
}
