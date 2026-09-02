import { expect, test } from "bun:test";
import { environmentName } from "../src/index";

test("reports the starter environment name", () => {
  expect(environmentName()).toBe("agentic-bun-project");
});
