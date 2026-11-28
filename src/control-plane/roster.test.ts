import { expect, test } from "bun:test";
import { parseApprovers } from "./roster";

test("only a handle that starts a row of the roster table is an approver", () => {
	const roster = [
		"# Approvers",
		"Ask [@someone](https://github.com/someone) before changing this file.",
		"| Handle | Since |",
		"|---|---|",
		"| [@tsontario](https://github.com/tsontario) | 2026-11-27 |",
		"|  [@second-one](https://github.com/second-one) | 2026-11-28 |",
		"| Added by [@third](https://github.com/third) | 2026-11-28 |",
		"| [@-leading](https://github.com/x) | 2026-11-28 |",
		"| [@trailing-](https://github.com/x) | 2026-11-28 |",
		"| [@not-a-link]x(https://github.com/x) | 2026-11-28 |",
	].join("\n");
	expect([...parseApprovers(roster)]).toEqual(["@tsontario", "@second-one"]);
});

test("a roster that lists no approvers is refused", () => {
	expect(() => parseApprovers("# Approvers\n\n| Handle | Since |\n|---|---|\n")).toThrow(/no approvers/);
});
