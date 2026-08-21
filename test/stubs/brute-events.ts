/**
 * 総当たり版の「期間内のトランジットイベント」。
 *
 * 細かい格子の**毎 tick で本物の `swe_calc_ut(jd, id, 260)`**を叩いて黄経と速度を取る
 * （14 日・全天体・10 分刻みなら 2 万回超）。**本番では使えない**が、events.ts の
 * 「疎サンプル＋3 次エルミート補間」が本当に同じ時刻を出すかを測る物差しとして要る。
 *
 * 状態機械の中身は events.ts と同じ意味で、違うのは**天体位置の供給源だけ**。
 * 境界の二分法も本物の天体計算で解くので、突き合わせで出る差は
 * 「格子の粗さ」ではなく**補間そのものの誤差**になる。
 */
import { CALC_FLAGS, DEFAULT_ORB, SIGNS, getHouse, planetName, signIndex, type SwissEph } from "../../src/astro/chart";
import {
  bodiesOf,
  wrap180,
  type Clip,
  type EventIngress,
  type EventTarget,
  type EventWindow,
  type StationEvent,
  type TransitEventScan,
  type TransitEventsInput,
} from "../../src/astro/events";

const BISECTION_STEPS = 10;

function clipOf(atStart: boolean, atEnd: boolean): Clip | null {
  if (atStart && atEnd) return "both";
  if (atStart) return "start";
  if (atEnd) return "end";
  return null;
}

/** events.ts の scanTransitEvents と同じ形を、毎 tick の本物の天体計算で作る */
export function bruteScanTransitEvents(
  swe: SwissEph,
  input: TransitEventsInput,
  tickMinutes: number,
): TransitEventScan {
  const { startJd, days } = input;
  const orb = input.orb ?? DEFAULT_ORB;
  const bodies = bodiesOf(input.bodies);
  const ticks = Math.round((days * 1440) / tickMinutes);
  const timeOf = (tick: number): number => (tick * tickMinutes) / 1440;

  let ephemerisCalls = 0;
  const positionAt = (id: number, t: number): { lon: number; speed: number } => {
    const result = swe.swe_calc_ut(startJd + t, id, CALC_FLAGS);
    ephemerisCalls++;
    return { lon: result[0] as number, speed: result[3] as number };
  };

  const bisect = (f: (t: number) => number, lo: number, hi: number): number => {
    let low = lo;
    let high = hi;
    const sign = Math.sign(f(low));
    for (let step = 0; step < BISECTION_STEPS; step++) {
      const middle = (low + high) / 2;
      if (Math.sign(f(middle)) === sign) low = middle;
      else high = middle;
    }
    return (low + high) / 2;
  };

  const targets: EventTarget[] = input.natalPlanets
    .filter((planet) => planet.id !== 11)
    .map((planet) => ({
      kind: "planet" as const,
      name: planetName(planet.id),
      id: planet.id,
      house: getHouse(planet.lon, input.cusps),
      lon: planet.lon,
    }));
  targets.push({ kind: "angle", name: "ASC", id: null, house: null, lon: input.angles.asc });
  targets.push({ kind: "angle", name: "MC", id: null, house: null, lon: input.angles.mc });

  const windows: EventWindow[] = [];
  const stations: StationEvent[] = [];
  const ingresses: EventIngress[] = [];

  for (const body of bodies) {
    const lon: number[] = [];
    const speed: number[] = [];
    for (let tick = 0; tick <= ticks; tick++) {
      const position = positionAt(body.id, timeOf(tick));
      lon.push(position.lon);
      speed.push(position.speed);
    }

    for (let tick = 1; tick <= ticks; tick++) {
      const wasRetrograde = (speed[tick - 1] as number) < 0;
      const isRetrograde = (speed[tick] as number) < 0;
      if (wasRetrograde === isRetrograde) continue;
      const t = bisect((x) => positionAt(body.id, x).speed, timeOf(tick - 1), timeOf(tick));
      stations.push({
        id: body.id,
        name: body.name,
        jd: startJd + t,
        to: isRetrograde ? "retrograde" : "direct",
        lon: positionAt(body.id, t).lon,
      });
    }

    for (let tick = 1; tick <= ticks; tick++) {
      const previousSign = signIndex(lon[tick - 1] as number);
      const currentSign = signIndex(lon[tick] as number);
      if (previousSign === currentSign) continue;
      const forward = currentSign === (previousSign + 1) % 12;
      const boundary = 30 * (forward ? currentSign : previousSign);
      const t = bisect(
        (x) => wrap180(positionAt(body.id, x).lon - boundary),
        timeOf(tick - 1),
        timeOf(tick),
      );
      ingresses.push({
        id: body.id,
        name: body.name,
        jd: startJd + t,
        signIndex: currentSign,
        sign: SIGNS[currentSign] as string,
        retrograde: positionAt(body.id, t).speed < 0,
      });
    }

    for (const target of targets) {
      for (const aspect of [
        { angle: 0, name: "コンジャンクション", symbol: "☌" },
        { angle: 60, name: "セクスタイル", symbol: "⚹" },
        { angle: 90, name: "スクエア", symbol: "□" },
        { angle: 120, name: "トライン", symbol: "△" },
        { angle: 180, name: "オポジション", symbol: "☍" },
      ]) {
        const branches =
          aspect.angle === 0 || aspect.angle === 180 ? [aspect.angle] : [aspect.angle, -aspect.angle];
        for (const branch of branches) {
          const errorAt = (t: number): number =>
            wrap180(positionAt(body.id, t).lon - target.lon - branch);
          let open: {
            entering: number | null;
            exact: number[];
            minOrb: number;
            minOrbAt: number;
            applyingAtStart: boolean;
          } | null = null;
          let previousError = 0;

          const close = (leaving: number | null): void => {
            const current = open as NonNullable<typeof open>;
            const exact = current.exact.map((t) => startJd + t);
            const window: EventWindow = {
              transitId: body.id,
              transit: body.name,
              target,
              aspect,
              entering: current.entering === null ? null : startJd + current.entering,
              exact,
              leaving: leaving === null ? null : startJd + leaving,
              minOrb: exact.length > 0 ? 0 : Math.round(current.minOrb * 1000) / 1000,
              minOrbAt: exact.length > 0 ? (exact[0] as number) : startJd + current.minOrbAt,
              applyingAtStart: current.applyingAtStart,
            };
            const clipped = clipOf(current.entering === null, leaving === null);
            if (clipped) window.clipped = clipped;
            windows.push(window);
          };

          for (let tick = 0; tick <= ticks; tick++) {
            const t = timeOf(tick);
            const error = wrap180((lon[tick] as number) - target.lon - branch);
            const inside = Math.abs(error) <= orb;

            if (inside) {
              if (!open) {
                const entering =
                  tick === 0
                    ? null
                    : bisect((x) => Math.abs(errorAt(x)) - orb, timeOf(tick - 1), t);
                const edge = positionAt(body.id, entering ?? 0);
                const edgeError = wrap180(edge.lon - target.lon - branch);
                open = {
                  entering,
                  exact: [],
                  minOrb: Math.abs(error),
                  minOrbAt: t,
                  applyingAtStart: edgeError * edge.speed < 0,
                };
              } else if (Math.abs(error) < open.minOrb) {
                open.minOrb = Math.abs(error);
                open.minOrbAt = t;
              }
              if (error === 0) {
                if (tick === 0 || previousError !== 0) open.exact.push(t);
              } else if (tick > 0 && previousError !== 0 && previousError * error < 0) {
                open.exact.push(bisect(errorAt, timeOf(tick - 1), t));
              }
            } else if (open) {
              close(bisect((x) => Math.abs(errorAt(x)) - orb, timeOf(tick - 1), t));
              open = null;
            }
            previousError = error;
          }
          if (open) close(null);
        }
      }
    }
  }

  windows.sort(
    (a, b) =>
      (a.entering ?? startJd) - (b.entering ?? startJd) ||
      a.transitId - b.transitId ||
      (a.target.id ?? 100) - (b.target.id ?? 100) ||
      a.aspect.angle - b.aspect.angle,
  );
  stations.sort((a, b) => a.jd - b.jd || a.id - b.id);
  ingresses.sort((a, b) => a.jd - b.jd || a.id - b.id);

  return {
    startJd,
    endJd: startJd + days,
    days,
    ephemerisCalls,
    windows,
    stations,
    ingresses,
  };
}
