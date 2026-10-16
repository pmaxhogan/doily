import { describe, expect, it } from "vitest";

import {
  configuredBounty,
  dailyCap,
  release,
  reserve,
  usage,
  utcDay,
} from "../../../src/scinet/spend.ts";
import { makeRequestToken, verifyRequestToken } from "../../../src/scinet/token.ts";
import { ToolError } from "../../../src/tools/types.ts";
import { toolRig } from "./fakes.ts";

describe("request tokens", () => {
  it("round-trips the DOI", async () => {
    const token = await makeRequestToken("k", "10.1038/nature12373");
    expect(token).toMatch(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
    expect(await verifyRequestToken("k", token)).toBe("10.1038/nature12373");
  });

  it("rejects a token signed with another secret", async () => {
    const token = await makeRequestToken("k1", "10.1038/nature12373");
    expect(await verifyRequestToken("k2", token)).toBeNull();
  });

  it("rejects a token whose DOI was swapped", async () => {
    const a = await makeRequestToken("k", "10.1/a");
    const b = await makeRequestToken("k", "10.1/b");
    const forged = `${b.split(".")[0]}.${a.split(".")[1]}`;
    expect(await verifyRequestToken("k", forged)).toBeNull();
  });

  it("rejects malformed tokens", async () => {
    expect(await verifyRequestToken("k", "nodot")).toBeNull();
    expect(await verifyRequestToken("k", "a.b.c")).toBeNull();
    expect(await verifyRequestToken("k", "!!.??")).toBeNull();
    expect(await verifyRequestToken("k", ".abc")).toBeNull();
  });

  it("refuses to run without a secret", async () => {
    await expect(makeRequestToken(undefined, "10.1/a")).rejects.toBeInstanceOf(ToolError);
    await expect(verifyRequestToken("", "a.b")).rejects.toThrow(/not configured/);
  });
});

describe("daily spend cap", () => {
  it("defaults to 5 requests of 2 tokens", () => {
    const { deps } = toolRig();
    expect(dailyCap(deps)).toBe(5);
    expect(configuredBounty(deps)).toBe(2);
  });

  it("reads overrides and ignores garbage", () => {
    expect(dailyCap(toolRig({ SCINET_DAILY_CAP: "3" }).deps)).toBe(3);
    expect(dailyCap(toolRig({ SCINET_DAILY_CAP: "lots" }).deps)).toBe(5);
    expect(configuredBounty(toolRig({ SCINET_BOUNTY: "1" }).deps)).toBe(1);
  });

  it("allows cap reservations per UTC day, then refuses", async () => {
    const { deps, db, clock } = toolRig({ SCINET_DAILY_CAP: "2" });
    await reserve(deps, 2);
    await reserve(deps, 2);
    const err = await reserve(deps, 2).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ToolError);
    expect((err as ToolError).toJSON()).toMatchObject({
      error: "daily Sci-Net request cap reached",
      cap: 2,
    });
    expect(db.rows.get(utcDay(clock.date()))).toEqual({ requests: 2, tokens: 4 });

    clock.advance(24 * 60 * 60 * 1000);
    await expect(reserve(deps, 2)).resolves.toMatchObject({ day: "2026-10-17" });
  });

  it("release gives a slot back", async () => {
    const { deps } = toolRig({ SCINET_DAILY_CAP: "1" });
    const { day } = await reserve(deps, 2);
    await release(deps, day, 2);
    await expect(reserve(deps, 2)).resolves.toBeDefined();
    expect(await usage(deps)).toEqual({ day, requests: 1, tokens: 2, cap: 1 });
  });

  it("a cap of 0 refuses everything", async () => {
    const { deps } = toolRig({ SCINET_DAILY_CAP: "0" });
    await expect(reserve(deps, 2)).rejects.toThrow(/cap reached/);
  });
});
