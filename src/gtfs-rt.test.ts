import { describe, expect, it } from "vitest";
import {
  decodeAlerts,
  decodeHeader,
  decodeTripUpdates,
  decodeVehicles,
  group,
  readFields,
} from "./gtfs-rt.js";

/* ------------------------------------------------------------------ */
/* Tiny protobuf encoder, test-only                                    */
/*                                                                     */
/* Building fixtures by hand keeps TransLink's data out of the repo    */
/* and makes every expected value explicit.                            */
/* ------------------------------------------------------------------ */

function varint(n: bigint): number[] {
  const out: number[] = [];
  let v = BigInt.asUintN(64, n);
  do {
    let byte = Number(v & 0x7fn);
    v >>= 7n;
    if (v > 0n) byte |= 0x80;
    out.push(byte);
  } while (v > 0n);
  return out;
}

const tag = (no: number, wire: number) => varint(BigInt((no << 3) | wire));

const fVarint = (no: number, n: number | bigint) => [...tag(no, 0), ...varint(BigInt(n))];

const fLen = (no: number, body: number[]) => [...tag(no, 2), ...varint(BigInt(body.length)), ...body];

const fStr = (no: number, s: string) => fLen(no, [...new TextEncoder().encode(s)]);

function fFloat(no: number, value: number): number[] {
  const buf = new DataView(new ArrayBuffer(4));
  buf.setFloat32(0, value, true);
  return [...tag(no, 5), ...new Uint8Array(buf.buffer)];
}

const bytes = (...parts: number[][]) => new Uint8Array(parts.flat());

/** FeedMessage.header — version "2.0" plus a timestamp. */
const header = (ts: number) => fLen(1, [...fStr(1, "2.0"), ...fVarint(3, ts)]);

/** FeedMessage.entity wrapper. */
const entity = (id: string, body: number[]) => fLen(2, [...fStr(1, id), ...body]);

/* ------------------------------------------------------------------ */

describe("readFields", () => {
  it("walks varint, length-delimited, and fixed32 fields", () => {
    const buf = bytes(fVarint(1, 150), fStr(2, "hi"), fFloat(3, 1.5));
    const fields = [...readFields(buf)];

    expect(fields).toHaveLength(3);
    expect(fields[0]).toMatchObject({ no: 1, wire: 0, value: 150n });
    expect(fields[1]!.no).toBe(2);
    expect(fields[2]).toMatchObject({ no: 3, wire: 5, value: 1.5 });
  });

  it("keeps every value of a repeated field", () => {
    const g = group(bytes(fVarint(7, 1), fVarint(7, 2), fVarint(7, 3)));
    expect(g.get(7)).toHaveLength(3);
  });

  it("throws when a length prefix runs past the buffer", () => {
    // Field 1, wire type 2, claims 99 bytes but supplies none.
    expect(() => [...readFields(new Uint8Array([0x0a, 99]))]).toThrow(/overruns buffer/);
  });

  it("throws on a truncated varint", () => {
    expect(() => [...readFields(new Uint8Array([0x08, 0x80]))]).toThrow(/past end of buffer/);
  });

  it("throws on a truncated fixed32 field", () => {
    // Field 3, wire type 5, needs four bytes but supplies two.
    expect(() => [...readFields(new Uint8Array([0x1d, 0x00, 0x00]))]).toThrow(/protobuf/);
  });

  it("throws on a truncated fixed64 field", () => {
    // Field 4, wire type 1, needs eight bytes but supplies three.
    expect(() => [...readFields(new Uint8Array([0x21, 0x00, 0x00, 0x00]))]).toThrow(/protobuf/);
  });
});

describe("decodeHeader", () => {
  it("reads the feed version and timestamp", () => {
    expect(decodeHeader(bytes(header(1788646491)))).toEqual({
      version: "2.0",
      timestamp: 1788646491,
    });
  });

  it("returns an empty header when the field is absent", () => {
    expect(decodeHeader(new Uint8Array())).toEqual({});
  });
});

describe("decodeVehicles", () => {
  /** VehiclePosition laid out exactly as TransLink sends it. */
  const vehicle = bytes(
    header(1788646491),
    entity(
      "15278786",
      fLen(4, [
        ...fLen(1, [...fStr(1, "15278786"), ...fStr(3, "20260905"), ...fStr(5, "30055"), ...fVarint(6, 0)]),
        ...fLen(2, [...fFloat(1, 49.28728), ...fFloat(2, -123.14187)]),
        ...fVarint(3, 1),
        ...fVarint(4, 2), // IN_TRANSIT_TO
        ...fVarint(5, 1788646461),
        ...fStr(7, "1"),
        ...fLen(8, [...fStr(1, "9406"), ...fStr(2, "9406")]),
      ]),
    ),
  );

  it("decodes position, trip, stop, and status", () => {
    const [bus] = decodeVehicles(vehicle);

    expect(bus).toBeDefined();
    expect(bus!.id).toBe("15278786");
    expect(bus!.tripId).toBe("15278786");
    expect(bus!.routeId).toBe("30055");
    expect(bus!.directionId).toBe(0);
    expect(bus!.vehicleId).toBe("9406");
    expect(bus!.lat).toBeCloseTo(49.28728, 5);
    expect(bus!.lon).toBeCloseTo(-123.14187, 5);
    expect(bus!.stopId).toBe("1");
    expect(bus!.stopSequence).toBe(1);
    expect(bus!.status).toBe("IN_TRANSIT_TO");
    expect(bus!.timestamp).toBe(1788646461);
  });

  it("leaves bearing undefined when the feed omits it, as TransLink does", () => {
    expect(decodeVehicles(vehicle)[0]!.bearing).toBeUndefined();
  });

  it("skips entities with no position rather than emitting a bus at null island", () => {
    const noPosition = bytes(entity("x", fLen(4, fLen(1, fStr(1, "trip")))));
    expect(decodeVehicles(noPosition)).toEqual([]);
  });

  it("drops buses parked at null island, which TransLink emits for a lost GPS fix", () => {
    const nullIsland = bytes(
      entity("nofix", fLen(4, fLen(2, [...fFloat(1, 0), ...fFloat(2, 0)]))),
      entity("good", fLen(4, fLen(2, [...fFloat(1, 49.28), ...fFloat(2, -123.14)]))),
    );
    expect(decodeVehicles(nullIsland).map((v) => v.id)).toEqual(["good"]);
  });

  it("drops positions outside valid lat/lon range", () => {
    const bogus = bytes(entity("bogus", fLen(4, fLen(2, [...fFloat(1, 91), ...fFloat(2, -123)]))));
    expect(decodeVehicles(bogus)).toEqual([]);
  });

  it("keeps a bus at a real position on the prime meridian", () => {
    // Only exactly (0,0) is rejected — lat 0 or lon 0 alone are legitimate.
    const meridian = bytes(entity("gh", fLen(4, fLen(2, [...fFloat(1, 51.48), ...fFloat(2, 0)]))));
    expect(decodeVehicles(meridian)).toHaveLength(1);
  });

  it("ignores trip_update entities mixed into the feed", () => {
    expect(decodeVehicles(bytes(entity("x", fLen(3, fStr(1, "trip")))))).toEqual([]);
  });

  it("decodes every entity in a multi-entity feed", () => {
    const two = bytes(
      header(1),
      entity("a", fLen(4, fLen(2, [...fFloat(1, 49.1), ...fFloat(2, -123.1)]))),
      entity("b", fLen(4, fLen(2, [...fFloat(1, 49.2), ...fFloat(2, -123.2)]))),
    );
    expect(decodeVehicles(two).map((v) => v.id)).toEqual(["a", "b"]);
  });
});

describe("decodeTripUpdates", () => {
  const stopTimeUpdate = (seq: number, stopId: string, time: number, delay: number) =>
    fLen(2, [
      ...fVarint(1, seq),
      ...fLen(2, [...fVarint(1, delay), ...fVarint(2, time)]), // arrival
      ...fStr(4, stopId),
    ]);

  it("decodes stop time predictions in order", () => {
    const buf = bytes(
      header(1788646491),
      entity(
        "15210065",
        fLen(3, [
          ...fLen(1, [...fStr(1, "15210065"), ...fStr(5, "6612")]),
          ...stopTimeUpdate(13, "72", 1788647851, 147),
          ...stopTimeUpdate(14, "73", 1788648062, 7),
          ...fLen(3, fStr(1, "9406")),
          ...fVarint(4, 1788646491),
        ]),
      ),
    );

    const [trip] = decodeTripUpdates(buf);

    expect(trip!.tripId).toBe("15210065");
    expect(trip!.routeId).toBe("6612");
    expect(trip!.vehicleId).toBe("9406");
    expect(trip!.stopTimeUpdates).toEqual([
      { stopSequence: 13, stopId: "72", time: 1788647851, delay: 147 },
      { stopSequence: 14, stopId: "73", time: 1788648062, delay: 7 },
    ]);
  });

  it("reads a negative delay, which protobuf encodes as 64-bit two's complement", () => {
    // trip_update → stop_time_update → arrival → { delay, time }
    const buf = bytes(
      entity("early", fLen(3, fLen(2, fLen(2, [...fVarint(1, -13), ...fVarint(2, 1788647851)])))),
    );

    // -13 goes on the wire as 18446744073709551603; a naive reader sees a huge positive.
    expect(decodeTripUpdates(buf)[0]!.stopTimeUpdates[0]!.delay).toBe(-13);
  });

  it("falls back to departure when a stop time update has no arrival", () => {
    const buf = bytes(
      entity("dep", fLen(3, fLen(2, [...fStr(4, "99"), ...fLen(3, fVarint(1, 42))]))),
    );
    expect(decodeTripUpdates(buf)[0]!.stopTimeUpdates[0]).toEqual({
      stopId: "99",
      stopSequence: undefined,
      time: undefined,
      delay: 42,
    });
  });

  it("returns an empty prediction list rather than throwing on a bare trip update", () => {
    const buf = bytes(entity("bare", fLen(3, fLen(1, fStr(1, "t1")))));
    expect(decodeTripUpdates(buf)[0]!.stopTimeUpdates).toEqual([]);
  });
});

describe("decodeAlerts", () => {
  const translated = (no: number, text: string) => fLen(no, fLen(1, [...fStr(1, text), ...fStr(2, "en")]));

  it("decodes cause, effect, active period, and text", () => {
    const buf = bytes(
      header(1788646483),
      entity(
        "454491",
        fLen(5, [
          ...fLen(1, [...fVarint(1, 1788600600), ...fVarint(2, 1788634200)]),
          ...fLen(5, [...fStr(1, "TL"), ...fStr(2, "30053"), ...fVarint(3, 1), ...fStr(5, "8578")]),
          ...fLen(5, [...fStr(2, "30053"), ...fStr(5, "8580")]),
          ...fVarint(6, 10), // CONSTRUCTION
          ...fVarint(7, 6), // MODIFIED_SERVICE
          ...translated(10, "Reduced service between Braid & Lougheed"),
          ...translated(11, "Some transfers may be required."),
        ]),
      ),
    );

    const [alert] = decodeAlerts(buf);

    expect(alert!.id).toBe("454491");
    expect(alert!.cause).toBe(10);
    expect(alert!.effect).toBe(6);
    expect(alert!.activeFrom).toBe(1788600600);
    expect(alert!.activeTo).toBe(1788634200);
    expect(alert!.header).toBe("Reduced service between Braid & Lougheed");
    expect(alert!.description).toBe("Some transfers may be required.");
    expect(alert!.informed).toEqual([
      { agencyId: "TL", routeId: "30053", routeType: 1, stopId: "8578" },
      { agencyId: undefined, routeId: "30053", routeType: undefined, stopId: "8580" },
    ]);
  });

  it("handles an open-ended active period", () => {
    const buf = bytes(entity("open", fLen(5, fLen(1, fVarint(1, 1788600600)))));
    const [alert] = decodeAlerts(buf);
    expect(alert!.activeFrom).toBe(1788600600);
    expect(alert!.activeTo).toBeUndefined();
  });

  it("survives an alert carrying no text at all", () => {
    const [alert] = decodeAlerts(bytes(entity("quiet", fLen(5, fVarint(6, 2)))));
    expect(alert!.header).toBeUndefined();
    expect(alert!.informed).toEqual([]);
  });
});
