const PLAN_LINE = /^1\.\.(\d+)$/u;
const RESULT_LINE = /^(not ok|ok)\s+(\d+)(?:\s|$)/u;

/**
 * Validate the TAP stream emitted by a pgTAP file run through psql.
 * psql exits successfully for ordinary `ok(false, ...)` assertions, so its
 * process status alone is not sufficient evidence that the suite passed.
 */
export function assertTapOutput(output, testFile = "pgTAP suite") {
  const lines = output
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter(Boolean);

  if (lines.some((line) => /^Bail out!/iu.test(line))) {
    throw new Error(`${testFile}: pgTAP bailed out`);
  }

  const plans = lines.flatMap((line) => {
    const match = PLAN_LINE.exec(line);
    return match ? [Number(match[1])] : [];
  });
  if (plans.length !== 1 || !Number.isSafeInteger(plans[0]) || plans[0] < 1) {
    throw new Error(`${testFile}: expected exactly one non-empty pgTAP plan`);
  }

  const results = lines.flatMap((line) => {
    const match = RESULT_LINE.exec(line);
    return match ? [{ status: match[1], number: Number(match[2]) }] : [];
  });
  const failures = results.filter((result) => result.status === "not ok");
  if (failures.length > 0) {
    throw new Error(
      `${testFile}: pgTAP failed assertion(s): ${failures.map(({ number }) => number).join(", ")}`,
    );
  }

  const expected = plans[0];
  if (results.length !== expected) {
    throw new Error(
      `${testFile}: pgTAP planned ${expected} assertions but emitted ${results.length}`,
    );
  }
  for (let index = 0; index < results.length; index += 1) {
    if (results[index]?.number !== index + 1) {
      throw new Error(`${testFile}: pgTAP assertion numbering is incomplete`);
    }
  }

  return { assertions: expected };
}
