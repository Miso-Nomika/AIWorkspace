// 홈 위젯 병합 (순수 함수 — node로 직접 테스트 가능). 여러 PC가 Drive에 각자 올린 홈을 합친다.
// 음악 목록 병합(music-merge.ts)과 같은 규칙: 위젯(id)마다 마지막으로 바꾼 쪽이 이기고, 지운 위젯은 삭제 기록(deleted)으로 남겨
// 다른 PC에서 되살아나지 않게 하며 30일 뒤 정리한다. 순서·크기·숨김은 PC끼리 공유한다 (크기는 상대 폭이라 화면 차이는 그리드가 흡수한다).
// 체크리스트를 누르는 것도 그 위젯을 바꾼 것으로 친다 — 두 PC가 거의 동시에 같은 위젯을 바꾸면 늦은 쪽이 이긴다.

import { HOME_MAX_ITEMS, migrateHome, type HomeFile, type HomeItem, type HomeTombstone } from "./home-widget-core.ts";

export const EPOCH = "1970-01-01T00:00:00.000Z";
export const HOME_TOMBSTONE_MAX_AGE_MS = 30 * 24 * 3600 * 1000;
/** 위젯 정의 하나의 최대 크기(JSON 글자 수) — 이보다 큰 항목은 다른 PC에서 받지 않는다 */
export const MAX_DEF_CHARS = 200_000;

const stampOf = (item: HomeItem) => item.updatedAt ?? EPOCH;

/** 다른 PC의 스냅샷(또는 저장된 값)을 홈으로 읽는다. 모양이 아예 틀리면 null, 너무 큰 위젯 정의는 건너뛴다 */
export function normalizeSnapshot(raw: unknown): HomeFile | null {
  const home = migrateHome(raw);
  if (!home) return null;
  const items = home.items.filter((item) => {
    try {
      return JSON.stringify(item.def ?? null).length <= MAX_DEF_CHARS;
    } catch {
      return false;
    }
  });
  return { ...home, items };
}

const sameJson = (a: unknown, b: unknown) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

/**
 * 사용자가 홈을 바꾼 직후(prev → next)에 수정 시각을 찍는다: 정의·크기·숨김이 바뀐 위젯은 updatedAt을 새로 찍고,
 * 사라진 위젯은 삭제 기록에 넣고, 위젯 순서가 바뀌면 orderAt을 새로 찍는다. 바뀌지 않은 것은 시각을 그대로 둔다.
 */
export function stampHome(prev: HomeFile, next: HomeFile, nowIso: string): HomeFile {
  const before = new Map(prev.items.map((i) => [i.id, i]));
  const items = next.items.map((item) => {
    const old = before.get(item.id);
    const changed = !old || item.size !== old.size || item.hidden !== old.hidden || !sameJson(item.def, old.def);
    return { ...item, updatedAt: changed ? nowIso : (old.updatedAt ?? item.updatedAt ?? EPOCH) };
  });
  const alive = new Set(items.map((i) => i.id));
  // 다시 살아난 id의 삭제 기록은 지우고, 이번에 사라진 위젯을 기록한다
  const deleted: HomeTombstone[] = (prev.deleted ?? next.deleted ?? []).filter((d) => !alive.has(d.id));
  for (const old of prev.items) {
    if (!alive.has(old.id) && !deleted.some((d) => d.id === old.id)) deleted.push({ id: old.id, deletedAt: nowIso });
  }
  const sameOrder = prev.items.length === next.items.length && prev.items.every((i, n) => i.id === next.items[n].id);
  const orderAt = sameOrder ? (prev.orderAt ?? next.orderAt) : nowIso;
  const result: HomeFile = { version: 1, items };
  if (deleted.length) result.deleted = deleted;
  if (orderAt) result.orderAt = orderAt;
  return result;
}

/**
 * 여러 PC의 홈(로컬 포함)을 합친다. 위젯마다 가장 늦게 바뀐 쪽을 고르고, 삭제 기록이 그 위젯의 마지막 수정과 같거나 더 늦으면 삭제가 이긴다.
 * 순서는 순서를 가장 늦게 바꾼 쪽(같으면 앞쪽 = 로컬)을 따르고, 거기에 없는 위젯은 로컬 순서대로, 그다음 수정 시각순으로 뒤에 붙인다.
 * 위젯이 30개를 넘으면 뒤쪽은 이 PC에 저장하지 않는다 (삭제 기록은 만들지 않아 다른 PC에는 그대로 남는다).
 */
export function mergeHome(lists: HomeFile[]): HomeFile {
  const live = new Map<string, HomeItem>();
  const tomb = new Map<string, string>();
  for (const home of lists) {
    for (const item of home.items) {
      const cur = live.get(item.id);
      if (!cur || stampOf(item) > stampOf(cur)) live.set(item.id, item);
    }
    for (const d of home.deleted ?? []) {
      if (!tomb.has(d.id) || d.deletedAt > (tomb.get(d.id) as string)) tomb.set(d.id, d.deletedAt);
    }
  }
  for (const [id, item] of [...live]) {
    const at = tomb.get(id);
    if (at !== undefined && at >= stampOf(item)) live.delete(id); // 삭제가 이김 (같은 시각이면 삭제)
  }
  // 살아남은 위젯이 이긴 삭제 기록은 필요 없다
  const deleted: HomeTombstone[] = [...tomb].filter(([id]) => !live.has(id)).map(([id, deletedAt]) => ({ id, deletedAt }));

  let base = lists[0];
  for (const home of lists) if ((home.orderAt ?? EPOCH) > (base.orderAt ?? EPOCH)) base = home;
  const ordered: string[] = [];
  const push = (id: string) => {
    if (live.has(id) && !ordered.includes(id)) ordered.push(id);
  };
  base.items.forEach((i) => push(i.id));
  (lists[0]?.items ?? []).forEach((i) => push(i.id));
  [...live.values()]
    .filter((i) => !ordered.includes(i.id))
    .sort((a, b) => (stampOf(a) === stampOf(b) ? (a.id < b.id ? -1 : 1) : stampOf(a) < stampOf(b) ? -1 : 1))
    .forEach((i) => push(i.id));

  const items = ordered.slice(0, HOME_MAX_ITEMS).map((id) => live.get(id) as HomeItem);
  const orderAt = lists.reduce((max, h) => ((h.orderAt ?? EPOCH) > max ? (h.orderAt as string) : max), EPOCH);
  const result: HomeFile = { version: 1, items };
  if (deleted.length) result.deleted = deleted;
  if (orderAt !== EPOCH) result.orderAt = orderAt;
  return result;
}

/** 오래된 삭제 기록을 정리한다 */
export function pruneHomeTombstones(home: HomeFile, nowMs: number): HomeFile {
  if (!home.deleted) return home;
  const deleted = home.deleted.filter((d) => nowMs - Date.parse(d.deletedAt) < HOME_TOMBSTONE_MAX_AGE_MS);
  if (deleted.length === home.deleted.length) return home;
  const { deleted: _drop, ...rest } = home;
  void _drop;
  return deleted.length ? { ...rest, deleted } : rest;
}

/** 두 홈이 같은 내용인지 (불필요한 저장·동기화를 막는다) */
export function sameHome(a: HomeFile, b: HomeFile): boolean {
  return JSON.stringify({ i: a.items, d: a.deleted ?? [], o: a.orderAt ?? null }) === JSON.stringify({ i: b.items, d: b.deleted ?? [], o: b.orderAt ?? null });
}

/** 스냅샷 파일의 안내 시각: 가장 나중에 바뀐 시각 (내용이 같으면 파일도 같아지게 현재 시각을 쓰지 않는다) */
export function homeStamp(home: HomeFile): string {
  let max = home.orderAt ?? EPOCH;
  for (const i of home.items) if (stampOf(i) > max) max = stampOf(i);
  for (const d of home.deleted ?? []) if (d.deletedAt > max) max = d.deletedAt;
  return max;
}
