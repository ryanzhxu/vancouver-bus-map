/**
 * Minimal GTFS-Realtime decoder.
 *
 * We hand-roll this instead of pulling in protobufjs + gtfs-realtime-bindings.
 * Two reasons: Workers bundles stay small, and we only need ~15 of the spec's
 * fields. Field numbers below are from gtfs-realtime.proto and were verified
 * against live TransLink v3 payloads.
 *
 * Spec: https://gtfs.org/documentation/realtime/reference/
 */

const WIRE_VARINT = 0;
const WIRE_I64 = 1;
const WIRE_LEN = 2;
const WIRE_I32 = 5;

/** One decoded protobuf field. `value` is a number for fixed types, bigint for
 *  varints, and a Uint8Array for length-delimited ones. */
export interface Field {
  no: number;
  wire: number;
  value: bigint | number | Uint8Array;
}

/** Walk the top-level fields of a protobuf message. */
export function* readFields(buf: Uint8Array): Generator<Field> {
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  let i = 0;

  while (i < buf.length) {
    const [tag, afterTag] = readVarint(buf, i);
    i = afterTag;
    const no = Number(tag >> 3n);
    const wire = Number(tag & 7n);

    switch (wire) {
      case WIRE_VARINT: {
        const [value, next] = readVarint(buf, i);
        i = next;
        yield { no, wire, value };
        break;
      }
      case WIRE_I64: {
        if (i + 8 > buf.length) throw new Error("protobuf: fixed64 field overruns buffer");
        yield { no, wire, value: view.getFloat64(i, true) };
        i += 8;
        break;
      }
      case WIRE_LEN: {
        const [len, afterLen] = readVarint(buf, i);
        i = afterLen;
        const end = i + Number(len);
        if (end > buf.length) throw new Error("protobuf: length-delimited field overruns buffer");
        yield { no, wire, value: buf.subarray(i, end) };
        i = end;
        break;
      }
      case WIRE_I32: {
        if (i + 4 > buf.length) throw new Error("protobuf: fixed32 field overruns buffer");
        yield { no, wire, value: view.getFloat32(i, true) };
        i += 4;
        break;
      }
      default:
        throw new Error(`protobuf: unsupported wire type ${wire}`);
    }
  }
}

function readVarint(buf: Uint8Array, start: number): [bigint, number] {
  let result = 0n;
  let shift = 0n;
  let i = start;

  while (i < buf.length) {
    const byte = buf[i]!;
    i++;
    result |= BigInt(byte & 0x7f) << shift;
    if ((byte & 0x80) === 0) return [result, i];
    shift += 7n;
    if (shift > 63n) throw new Error("protobuf: varint longer than 64 bits");
  }
  throw new Error("protobuf: varint ran past end of buffer");
}

/* ------------------------------------------------------------------ */
/* Field accessors                                                     */
/* ------------------------------------------------------------------ */

/** Group a message's fields by field number. Repeated fields keep every value. */
export function group(buf: Uint8Array): Map<number, Field[]> {
  const out = new Map<number, Field[]>();
  for (const f of readFields(buf)) {
    const existing = out.get(f.no);
    if (existing) existing.push(f);
    else out.set(f.no, [f]);
  }
  return out;
}

const decoder = new TextDecoder();

function bytes(g: Map<number, Field[]>, no: number): Uint8Array | undefined {
  const v = g.get(no)?.[0]?.value;
  return v instanceof Uint8Array ? v : undefined;
}

function str(g: Map<number, Field[]>, no: number): string | undefined {
  const b = bytes(g, no);
  return b === undefined ? undefined : decoder.decode(b);
}

/** Unsigned varint as a JS number. Safe for timestamps and sequences. */
function uint(g: Map<number, Field[]>, no: number): number | undefined {
  const v = g.get(no)?.[0]?.value;
  return typeof v === "bigint" ? Number(v) : undefined;
}

/**
 * Signed 32-bit varint. Negative values are encoded as 64-bit two's complement,
 * so a delay of -13s arrives as 18446744073709551603 and must be reinterpreted.
 */
function int32(g: Map<number, Field[]>, no: number): number | undefined {
  const v = g.get(no)?.[0]?.value;
  return typeof v === "bigint" ? Number(BigInt.asIntN(64, v)) : undefined;
}

/** Signed 64-bit varint, for absolute epoch times. */
function int64(g: Map<number, Field[]>, no: number): number | undefined {
  const v = g.get(no)?.[0]?.value;
  return typeof v === "bigint" ? Number(BigInt.asIntN(64, v)) : undefined;
}

function float(g: Map<number, Field[]>, no: number): number | undefined {
  const v = g.get(no)?.[0]?.value;
  return typeof v === "number" ? v : undefined;
}

/* ------------------------------------------------------------------ */
/* Decoded shapes                                                      */
/* ------------------------------------------------------------------ */

export type VehicleStatus = "INCOMING_AT" | "STOPPED_AT" | "IN_TRANSIT_TO";

const VEHICLE_STATUS: Record<number, VehicleStatus> = {
  0: "INCOMING_AT",
  1: "STOPPED_AT",
  2: "IN_TRANSIT_TO",
};

export interface Vehicle {
  /** FeedEntity.id — stable for the life of a trip. */
  id: string;
  tripId?: string;
  routeId?: string;
  directionId?: number;
  vehicleId?: string;
  lat: number;
  lon: number;
  /** TransLink does not populate bearing; kept for feeds that do. */
  bearing?: number;
  stopId?: string;
  stopSequence?: number;
  status?: VehicleStatus;
  timestamp?: number;
}

export interface StopTimePrediction {
  stopId?: string;
  stopSequence?: number;
  /** Absolute epoch seconds, when the feed provides one. */
  time?: number;
  /** Seconds against schedule. Negative means early. */
  delay?: number;
}

export interface TripUpdate {
  id: string;
  tripId?: string;
  routeId?: string;
  vehicleId?: string;
  timestamp?: number;
  stopTimeUpdates: StopTimePrediction[];
}

export interface AlertEntity {
  agencyId?: string;
  routeId?: string;
  routeType?: number;
  stopId?: string;
}

export interface Alert {
  id: string;
  cause?: number;
  effect?: number;
  url?: string;
  header?: string;
  description?: string;
  activeFrom?: number;
  activeTo?: number;
  informed: AlertEntity[];
}

export interface FeedHeader {
  version?: string;
  timestamp?: number;
}

/* ------------------------------------------------------------------ */
/* Entry points                                                        */
/* ------------------------------------------------------------------ */

/** FeedMessage.header (field 1). */
export function decodeHeader(buf: Uint8Array): FeedHeader {
  for (const f of readFields(buf)) {
    if (f.no === 1 && f.value instanceof Uint8Array) {
      const g = group(f.value);
      return { version: str(g, 1), timestamp: uint(g, 3) };
    }
  }
  return {};
}

/** Iterate FeedMessage.entity (field 2), yielding the entity's id and body. */
function* entities(buf: Uint8Array): Generator<{ id: string; g: Map<number, Field[]> }> {
  for (const f of readFields(buf)) {
    if (f.no !== 2 || !(f.value instanceof Uint8Array)) continue;
    const g = group(f.value);
    yield { id: str(g, 1) ?? "", g };
  }
}

/**
 * Reject positions we cannot plot. Beyond missing or out-of-range values, a
 * small number of TransLink vehicles report exactly (0, 0) each poll — the
 * classic "null island" artifact of a vehicle with no GPS fix. Left in, those
 * buses render in the Gulf of Guinea.
 */
function isRealPosition(lat: number, lon: number): boolean {
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return false;
  if (lat === 0 && lon === 0) return false;
  return Math.abs(lat) <= 90 && Math.abs(lon) <= 180;
}

function tripDescriptor(buf: Uint8Array) {
  const g = group(buf);
  return {
    tripId: str(g, 1),
    routeId: str(g, 5),
    directionId: uint(g, 6),
  };
}

/** Decode FeedEntity.vehicle (field 4) from a VehiclePositions feed. */
export function decodeVehicles(buf: Uint8Array): Vehicle[] {
  const out: Vehicle[] = [];

  for (const { id, g } of entities(buf)) {
    const body = bytes(g, 4);
    if (!body) continue;
    const v = group(body);

    const posBytes = bytes(v, 2);
    if (!posBytes) continue;
    const pos = group(posBytes);
    const lat = float(pos, 1);
    const lon = float(pos, 2);
    if (lat === undefined || lon === undefined) continue;
    if (!isRealPosition(lat, lon)) continue;

    const tripBytes = bytes(v, 1);
    const trip = tripBytes ? tripDescriptor(tripBytes) : {};
    const descBytes = bytes(v, 8);
    const statusCode = uint(v, 4);

    out.push({
      id,
      ...trip,
      vehicleId: descBytes ? str(group(descBytes), 1) : undefined,
      lat,
      lon,
      bearing: float(pos, 3),
      stopId: str(v, 7),
      stopSequence: uint(v, 3),
      status: statusCode === undefined ? undefined : VEHICLE_STATUS[statusCode],
      timestamp: uint(v, 5),
    });
  }

  return out;
}

/** Decode FeedEntity.trip_update (field 3) from a TripUpdates feed. */
export function decodeTripUpdates(buf: Uint8Array): TripUpdate[] {
  const out: TripUpdate[] = [];

  for (const { id, g } of entities(buf)) {
    const body = bytes(g, 3);
    if (!body) continue;
    const tu = group(body);

    const tripBytes = bytes(tu, 1);
    const trip = tripBytes ? tripDescriptor(tripBytes) : {};
    const descBytes = bytes(tu, 3);

    const stopTimeUpdates: StopTimePrediction[] = [];
    for (const f of tu.get(2) ?? []) {
      if (!(f.value instanceof Uint8Array)) continue;
      const stu = group(f.value);

      // Prefer arrival (field 2); fall back to departure (field 3).
      const eventBytes = bytes(stu, 2) ?? bytes(stu, 3);
      const event = eventBytes ? group(eventBytes) : undefined;

      stopTimeUpdates.push({
        stopId: str(stu, 4),
        stopSequence: uint(stu, 1),
        time: event ? int64(event, 2) : undefined,
        delay: event ? int32(event, 1) : undefined,
      });
    }

    out.push({
      id,
      ...trip,
      vehicleId: descBytes ? str(group(descBytes), 1) : undefined,
      timestamp: uint(tu, 4),
      stopTimeUpdates,
    });
  }

  return out;
}

/** Decode FeedEntity.alert (field 5) from a ServiceAlerts feed. */
export function decodeAlerts(buf: Uint8Array): Alert[] {
  const out: Alert[] = [];

  for (const { id, g } of entities(buf)) {
    const body = bytes(g, 5);
    if (!body) continue;
    const a = group(body);

    const periodBytes = bytes(a, 1);
    const period = periodBytes ? group(periodBytes) : undefined;

    const informed: AlertEntity[] = [];
    for (const f of a.get(5) ?? []) {
      if (!(f.value instanceof Uint8Array)) continue;
      const sel = group(f.value);
      informed.push({
        agencyId: str(sel, 1),
        routeId: str(sel, 2),
        routeType: uint(sel, 3),
        stopId: str(sel, 5),
      });
    }

    out.push({
      id,
      cause: uint(a, 6),
      effect: uint(a, 7),
      url: translated(bytes(a, 8)),
      header: translated(bytes(a, 10)),
      description: translated(bytes(a, 11)),
      activeFrom: period ? uint(period, 1) : undefined,
      activeTo: period ? uint(period, 2) : undefined,
      informed,
    });
  }

  return out;
}

/** TranslatedString → the first translation's text. TransLink ships English only. */
function translated(buf: Uint8Array | undefined): string | undefined {
  if (!buf) return undefined;
  for (const f of readFields(buf)) {
    if (f.no === 1 && f.value instanceof Uint8Array) {
      return str(group(f.value), 1);
    }
  }
  return undefined;
}
