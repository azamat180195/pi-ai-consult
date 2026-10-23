export interface Hotspot {
  location: string; // file:line or service
  why_hard: string;
  evidence: string; // log snippet, grep output, metric
}

export interface Hypothesis {
  statement: string;
  confidence: number; // 0 - 100%
  alternatives_considered: string[];
  falsified_if: string;
}

export interface BriefData {
  goal: string;
  environment: string; // versions, OS, traffic, SLO
  hotspots: Hotspot[];
  hypothesis: Hypothesis;
  verified_locally?: string[];
  unknowns?: string[];
}

export interface OpenIssue {
  id: string;
  claim: string;
  status: "open" | "verified" | "accepted_risk" | "rejected";
  evidence_level?: "ran_locally" | "source_or_docs" | "reasoning" | "assertion";
  challenge_question?: string;
}

export function formatBrief(b: BriefData): string {
  const hotspotsText = b.hotspots
    .map(
      (h, i) =>
        `  ${i + 1}. [${h.location}]: ${h.why_hard}\n     Evidence: ${h.evidence}`,
    )
    .join("\n");

  const verified =
    b.verified_locally && b.verified_locally.length > 0
      ? b.verified_locally.map((v) => `  - ${v}`).join("\n")
      : "  - None yet";

  const unknowns =
    b.unknowns && b.unknowns.length > 0
      ? b.unknowns.map((u) => `  - ${u}`).join("\n")
      : "  - None stated";

  const alts = b.hypothesis.alternatives_considered.join("; ") || "None";

  return `You are acting as a senior infrastructure and software architect performing a rigorous design review. Be direct and critical; disagree with me if my thinking is flawed.

GOAL: ${b.goal}
ENVIRONMENT: ${b.environment}

HOTSPOTS & CHALLENGING PARTS (I analyzed these myself):
${hotspotsText}

MY INITIAL HYPOTHESIS (${b.hypothesis.confidence}% confidence): ${b.hypothesis.statement}
Alternatives I already considered: ${alts}
My hypothesis would be WRONG/falsified if: ${b.hypothesis.falsified_if}

ALREADY VERIFIED LOCALLY:
${verified}

UNKNOWN / CANNOT TEST LOCALLY:
${unknowns}

Please structure your review as follows:
1. Verdict on my hypothesis (Agree / Partially Agree / Disagree) with exact technical reasoning.
2. Your recommended architecture/implementation with copy-paste ready code/configs.
3. At least 2 alternative approaches and why you rejected each in this context.
4. Failure mode analysis: race conditions, resource leaks, downtime risks, traffic spike behavior.
5. Critical assumptions you are making and conditions under which your recommendation would FAIL.
6. What specific data from me would change your mind? List exact commands/files you need.`;
}

export function formatChallenge(
  round: number,
  issues: OpenIssue[],
  customQuestions?: string,
): string {
  const issuesList = issues
    .map(
      (iss) =>
        `[${iss.id}] Claim: "${iss.claim}"\nQuestion/Challenge: ${
          iss.challenge_question ||
          "Why did you choose this over alternatives, and how does it prevent race conditions / downtime?"
        }`,
    )
    .join("\n\n");

  return `Review Round ${round} - Critical Challenge & Adversarial Review.
Answer each open point separately by ID. Do NOT agree just to be polite; if my concern is unfounded, state why with concrete technical evidence.

${issuesList}

${customQuestions ? `Additional Architectural Questions:\n${customQuestions}\n` : ""}
For each item, provide:
- Direct Answer
- Evidence (official docs, source code reference, exact command to run)
- Confidence (0-100%)
- What would change your mind or prove this wrong`;
}

export function formatRedTeam(finalPlan: string): string {
  return `Final Red-Team Gate. Here is the solution as I plan to apply it:
${finalPlan}

Assume this solution FAILS in production within 24 hours of deployment.
1. List the top 3 most likely root causes, ordered by probability.
2. For each cause, specify the detection signal (metric/log) and exact mitigation.
3. Identify any step that is IRREVERSIBLE and what must be verified before running it.`;
}
