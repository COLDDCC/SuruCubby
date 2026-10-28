/**
 * 一个日本订单常常分几个快递到（骏河屋按仓库拆单）。每个日本运单号登记一行 jp_shipments，
 * 到了就记上谁、什么时候签的；日本仓和管理员都看得出哪个快递还没到。
 *
 * 运单号的来源：导入页 / 订单详情填的（可以一次填几个，逗号、顿号、换行隔开）、
 * 导入表里每行的「日本运单号」、日本仓后来补登的、分拣时填的。
 */
import { normalizeTrackingNo } from './excel.ts';

/** 「4908-1111-0001，490811110002」→ ['490811110001', '490811110002']。不按空格拆：EMS 单号常写成 EB 111 222 333 JP。 */
export function parseTrackingList(raw: unknown): string[] {
  if (typeof raw !== 'string') return [];
  const out: string[] = [];
  for (const part of raw.split(/[,，、;；\n\r/／|]+/)) {
    const tn = normalizeTrackingNo(part);
    if (tn && !out.includes(tn)) out.push(tn);
  }
  return out;
}

export function registerStmts(db: D1Database, batchId: number, trackingNos: string[], at: string): D1PreparedStatement[] {
  return trackingNos.map((tn) =>
    db
      .prepare('INSERT OR IGNORE INTO jp_shipments (batch_id, tracking_no, created_at) VALUES (?, ?, ?)')
      .bind(batchId, tn, at),
  );
}

/** 登记并标「已到」：重复到货不改第一次的时间和人。 */
export function arriveStmts(db: D1Database, batchId: number, tn: string, by: string, at: string): D1PreparedStatement[] {
  return [
    ...registerStmts(db, batchId, [tn], at),
    db
      .prepare(
        `UPDATE jp_shipments SET arrived_at = COALESCE(arrived_at, ?), arrived_by = COALESCE(arrived_by, ?)
          WHERE batch_id = ? AND tracking_no = ?`,
      )
      .bind(at, by, batchId, tn),
  ];
}

export interface ShipmentRow {
  batchId: number;
  trackingNo: string;
  arrivedAt: string | null;
  arrivedBy: string | null;
  /** 表里写了这个运单号、还没分拣的件 */
  waiting: number;
  /** 写了这个运单号的件一共几件 */
  itemCount: number;
}

export async function loadShipments(db: D1Database, batchIds: number[]): Promise<Map<number, ShipmentRow[]>> {
  const map = new Map<number, ShipmentRow[]>();
  if (!batchIds.length) return map;
  const marks = batchIds.map(() => '?').join(', ');
  const rows = await db
    .prepare(
      `SELECT s.batch_id AS batchId, s.tracking_no AS trackingNo, s.arrived_at AS arrivedAt, s.arrived_by AS arrivedBy,
              (SELECT COUNT(*) FROM items i WHERE i.batch_id = s.batch_id AND i.jp_tracking_no = s.tracking_no
                  AND i.sorted_at IS NULL AND i.status IN ('ordered', 'jp_warehouse') AND i.direct_parcel_id IS NULL) AS waiting,
              (SELECT COUNT(*) FROM items i WHERE i.batch_id = s.batch_id AND i.jp_tracking_no = s.tracking_no) AS itemCount
         FROM jp_shipments s WHERE s.batch_id IN (${marks})
        ORDER BY s.batch_id, s.arrived_at IS NOT NULL, s.id`,
    )
    .bind(...batchIds)
    .all<ShipmentRow>();
  for (const r of rows.results) map.set(r.batchId, [...(map.get(r.batchId) ?? []), r]);
  return map;
}
