/**
 * 総当たり版の年間概要 ―― calc.js の calcYearlyRange を素直に TS へ写したもの。
 *
 * 毎日・毎天体 `swe_calc_ut(jd, id, 260)` を叩いて黄経と速度を取る（≒2,900 回）。
 * **本番では使えない**（Workers の CPU 上限 10ms を 12 倍超える）が、
 * yearly.ts の「疎サンプル＋3 次補間」が本当に同じ答えを出すかを測る物差しとして要る。
 *
 * 状態機械の中身は yearly.ts と同じ意味で、違うのは**天体位置の供給源だけ**。
 */
import {
  CALC_FLAGS,
  DEFAULT_ORB,
  SIGNS,
  getAspect,
  getHouse,
  planetName,
  signIndex,
  type SwissEph,
} from "../../src/astro/chart";
import {
  YEARLY_PLANETS,
  type AngleAspectWindow,
  type Clip,
  type IngressEvent,
  type NatalAspectWindow,
  type RetrogradePeriod,
  type YearlyScan,
  type YearlyScanInput,
} from "../../src/astro/yearly";

function clipOf(atStart: boolean, atEnd: boolean): Clip | null {
  if (atStart && atEnd) return "both";
  if (atStart) return "start";
  if (atEnd) return "end";
  return null;
}

interface OpenWindow {
  aspect: { angle: number; name: string; symbol: string };
  startD: number;
  exactD: number;
  minOrb: number;
}

/** yearly.ts の scanYearlyRange と同じ形を、総当たりで作る */
export function bruteScanYearlyRange(swe: SwissEph, input: YearlyScanInput): YearlyScan {
  const { startJd, endJd } = input;
  const orb = input.orb ?? DEFAULT_ORB;
  const days = Math.floor(endJd - startJd);

  let ephemerisCalls = 0;
  const lon = new Map<number, number[]>();
  const speed = new Map<number, number[]>();
  for (const planet of YEARLY_PLANETS) {
    const lons: number[] = [];
    const speeds: number[] = [];
    for (let d = 0; d <= days; d++) {
      const result = swe.swe_calc_ut(startJd + d, planet.id, CALC_FLAGS);
      ephemerisCalls++;
      lons.push(result[0] as number);
      speeds.push(result[3] as number);
    }
    lon.set(planet.id, lons);
    speed.set(planet.id, speeds);
  }

  const retrogrades: RetrogradePeriod[] = [];
  const ingresses: IngressEvent[] = [];
  for (const planet of YEARLY_PLANETS) {
    const speeds = speed.get(planet.id) as number[];
    const lons = lon.get(planet.id) as number[];

    let start: number | null = null;
    for (let d = 0; d <= days; d++) {
      const retro = (speeds[d] as number) < 0;
      if (retro && start === null) start = d;
      else if (!retro && start !== null) {
        const period: RetrogradePeriod = {
          id: planet.id,
          planet: planet.name,
          startJd: startJd + start,
          endJd: startJd + d,
        };
        const clipped = clipOf(start === 0, false);
        if (clipped) period.clipped = clipped;
        retrogrades.push(period);
        start = null;
      }
    }
    if (start !== null) {
      const period: RetrogradePeriod = {
        id: planet.id,
        planet: planet.name,
        startJd: startJd + start,
        endJd,
      };
      const clipped = clipOf(start === 0, true);
      if (clipped) period.clipped = clipped;
      retrogrades.push(period);
    }

    if (!planet.ingress) continue;
    for (let d = 1; d <= days; d++) {
      const sign = signIndex(lons[d] as number);
      if (sign === signIndex(lons[d - 1] as number)) continue;
      ingresses.push({
        id: planet.id,
        planet: planet.name,
        jd: startJd + d,
        signIndex: sign,
        sign: SIGNS[sign] as string,
        retrograde: (speeds[d] as number) < 0,
      });
    }
  }
  ingresses.sort((a, b) => a.jd - b.jd || a.id - b.id);

  const natalTargets = input.natalPlanets.filter((planet) => planet.id !== 11);
  const angleAspects: AngleAspectWindow[] = [];
  const natalAspects: NatalAspectWindow[] = [];

  for (const planet of YEARLY_PLANETS) {
    if (!planet.transit) continue;
    const lons = lon.get(planet.id) as number[];

    const windowsFor = (targetLon: number): (OpenWindow & { endD: number | null })[] => {
      const found: (OpenWindow & { endD: number | null })[] = [];
      let open: OpenWindow | null = null;
      for (let d = 0; d <= days; d++) {
        const hit = getAspect(lons[d] as number, targetLon, orb);
        if (hit) {
          if (!open) {
            open = {
              aspect: { angle: hit.angle, name: hit.name, symbol: hit.symbol },
              startD: d,
              exactD: d,
              minOrb: hit.orb,
            };
          } else if (hit.orb < open.minOrb) {
            open.minOrb = hit.orb;
            open.exactD = d;
          }
        } else if (open) {
          found.push({ ...open, endD: d });
          open = null;
        }
      }
      if (open) found.push({ ...open, endD: null });
      return found;
    };

    for (const natal of natalTargets) {
      for (const window of windowsFor(natal.lon)) {
        const built: NatalAspectWindow = {
          aspect: window.aspect,
          startJd: startJd + window.startD,
          endJd: window.endD === null ? endJd : startJd + window.endD,
          exactJd: startJd + window.exactD,
          minOrb: Math.round(window.minOrb * 1000) / 1000,
          transitId: planet.id,
          transit: planet.name,
          natalId: natal.id,
          natal: planetName(natal.id),
          house: getHouse(natal.lon, input.cusps),
        };
        const clipped = clipOf(window.startD === 0, window.endD === null);
        if (clipped) built.clipped = clipped;
        natalAspects.push(built);
      }
    }

    for (const angle of [
      { name: "ASC" as const, lon: input.angles.asc },
      { name: "MC" as const, lon: input.angles.mc },
    ]) {
      for (const window of windowsFor(angle.lon)) {
        const built: AngleAspectWindow = {
          aspect: window.aspect,
          startJd: startJd + window.startD,
          endJd: window.endD === null ? endJd : startJd + window.endD,
          exactJd: startJd + window.exactD,
          minOrb: Math.round(window.minOrb * 1000) / 1000,
          transitId: planet.id,
          transit: planet.name,
          angle: angle.name,
        };
        const clipped = clipOf(window.startD === 0, window.endD === null);
        if (clipped) built.clipped = clipped;
        angleAspects.push(built);
      }
    }
  }

  angleAspects.sort(
    (a, b) =>
      a.startJd - b.startJd ||
      a.transitId - b.transitId ||
      (a.angle === "ASC" ? 0 : 1) - (b.angle === "ASC" ? 0 : 1),
  );
  natalAspects.sort(
    (a, b) => a.startJd - b.startJd || a.transitId - b.transitId || a.natalId - b.natalId,
  );

  return { days, ephemerisCalls, retrogrades, ingresses, angleAspects, natalAspects };
}
