import assert from "node:assert/strict";
import test from "node:test";
import { evaluatePullRequestState, parseMergeReadyVerdict, parsePullRequestMetadata } from "../src/delivery.js";

test("pull-request metadata parser accepts fenced agent output", () => {
  assert.deepEqual(
    parsePullRequestMetadata(
      'Drafted from the diff.\n```json\n{"title":"Improve auth","body":"## Summary\\nSafer auth."}\n```',
    ),
    { title: "Improve auth", body: "## Summary\nSafer auth." },
  );
});

test("merge-readiness parser requires a structured boolean verdict", () => {
  assert.deepEqual(parseMergeReadyVerdict('{"ready":false,"summary":"CI is pending","evidence":["build job"]}'), {
    ready: false,
    summary: "CI is pending",
    evidence: ["build job"],
  });
  assert.equal(parseMergeReadyVerdict('{"ready":"yes","summary":"done"}'), null);
});

test("pull-request state requires successful checks and completed reviews", () => {
  assert.deepEqual(
    evaluatePullRequestState({
      state: "OPEN",
      isDraft: false,
      mergeable: "MERGEABLE",
      reviewDecision: "APPROVED",
      statusCheckRollup: [{ status: "COMPLETED", conclusion: "SUCCESS" }],
    }),
    { ready: true, reasons: [], checks: ["passed"] },
  );

  const blocked = evaluatePullRequestState({
    state: "OPEN",
    isDraft: false,
    mergeable: "CONFLICTING",
    reviewDecision: "CHANGES_REQUESTED",
    statusCheckRollup: [{ status: "COMPLETED", conclusion: "FAILURE" }],
  });
  assert.equal(blocked.ready, false);
  assert.match(blocked.reasons.join("; "), /mergeability is CONFLICTING/);
  assert.match(blocked.reasons.join("; "), /review changes are requested/);
  assert.match(blocked.reasons.join("; "), /checks failed/);
});
