import { z } from "zod";
import { ARTIST_BRIEF } from "./project";
import { parseModelJson, type ModelRunner } from "../autonomy/runtime";

export const sunoPreparationSchema = z.object({
  decision: z.enum(["READY", "REVISE"]),
  reason: z.string().min(20).max(1200),
  stylePrompt: z.string().max(1400),
  qualityChecks: z.array(z.string().max(250)).min(2).max(6)
});

export const sunoSubmissionSchema = z.object({
  handoffId: z.string().min(1).max(250),
  sunoUrl: z
    .url()
    .max(500)
    .refine((value) => {
      const url = new URL(value);
      return (
        url.protocol === "https:" &&
        (url.hostname === "suno.com" || url.hostname.endsWith(".suno.com"))
      );
    }, "A Suno HTTPS link is required"),
  listeningNotes: z.string().min(30).max(3000),
  rightsBasis: z.enum(["PAID_AT_CREATION", "FREE", "UNKNOWN"]),
  audioEvidence: z
    .object({
      filename: z.string().max(160),
      byteLength: z.number().int().positive().max(10_000_000),
      sha256: z.string().regex(/^[a-f0-9]{64}$/),
      transcript: z.string().max(12000)
    })
    .nullable()
});

export const sunoAuditSchema = z.object({
  decision: z.enum([
    "RELEASE_CANDIDATE",
    "REVISE",
    "REJECT",
    "INSUFFICIENT_EVIDENCE"
  ]),
  summary: z.string().min(20).max(1600),
  lyricFidelity: z.string().min(10).max(1200),
  strengths: z.array(z.string().max(350)).max(5),
  issues: z.array(z.string().max(350)).max(5),
  uncertainties: z.array(z.string().max(350)).max(5),
  releaseProposal: z.string().max(2400)
});

export type SunoPreparation = z.infer<typeof sunoPreparationSchema>;
export type SunoSubmission = z.infer<typeof sunoSubmissionSchema>;
export type SunoAudit = z.infer<typeof sunoAuditSchema>;

export type SunoHandoff = {
  id: string;
  sourceArtifactId: string;
  sourceMissionId: string;
  title: string;
  lyrics: string;
  preparation: SunoPreparation | null;
  status:
    | "PREPARING"
    | "READY_FOR_SUNO"
    | "NEEDS_REVISION"
    | "AWAITING_AUDIO"
    | "AUDITING"
    | "RELEASE_PROPOSED"
    | "REVISION_REQUIRED"
    | "RIGHTS_CHECK_REQUIRED"
    | "AUDIT_INCONCLUSIVE"
    | "FAILED";
  submission: SunoSubmission | null;
  audit: SunoAudit | null;
  lastError?: string;
  createdAt: string;
  updatedAt: string;
};

export function sunoAuditStatus(
  decision: SunoAudit["decision"],
  rightsBasis: SunoSubmission["rightsBasis"]
): SunoHandoff["status"] {
  if (decision === "RELEASE_CANDIDATE")
    return rightsBasis === "PAID_AT_CREATION"
      ? "RELEASE_PROPOSED"
      : "RIGHTS_CHECK_REQUIRED";
  return decision === "INSUFFICIENT_EVIDENCE"
    ? "AUDIT_INCONCLUSIVE"
    : "REVISION_REQUIRED";
}

export function songText(content: string): { title: string; lyrics: string } {
  try {
    const parsed: unknown = JSON.parse(content);
    if (parsed && typeof parsed === "object" && "body" in parsed) {
      const body = parsed.body;
      if (typeof body === "string") {
        const titleLine = body.match(/^TITLE:\s*(.+)$/im)?.[1]?.trim();
        const lyrics = body
          .replace(/^TITLE:\s*.+\r?\n+/i, "")
          .split(/\n\s*Change Log:/i, 1)[0]
          .replace(
            /^(VERSE(?:\s+\d+)?|PRE[- ]CHORUS|CHORUS|BRIDGE|FINAL CHORUS|OUTRO|INTRO)$/gim,
            "[$1]"
          )
          .trim();
        return {
          title: (
            titleLine ??
            ("title" in parsed && typeof parsed.title === "string"
              ? parsed.title
              : "Untitled song")
          ).slice(0, 160),
          lyrics: lyrics.slice(0, 8000)
        };
      }
    }
  } catch {
    // Legacy plain-text drafts are accepted.
  }
  return {
    title: content.split("\n", 1)[0].slice(0, 160),
    lyrics: content.slice(0, 8000)
  };
}

export async function prepareSunoPackage(
  input: {
    title: string;
    lyrics: string;
    lyricReview: string;
    productionBrief: string;
  },
  runModel: ModelRunner
): Promise<SunoPreparation> {
  const reply = await runModel(
    "SUNO_PREPARER",
    `You are the independent A&R and production gate before a human uses Suno Custom mode. Decide whether the revised original lyrics are ready to turn into a demo. Reject generic, incomplete or weak songs; do not approve merely because a draft exists. Consider the lyric review, clear emotional thesis, memorable chorus, distinct imagery, singability and coherent artist identity. If READY, write a concise English Style of Music prompt for Suno (genre, tempo/groove, instrumentation, female vocal character, dynamic arc and production texture). The style prompt must contain NO lyrics, artist names, voice clones or claims about a finished recording. Do not use Suno or spend credits yourself. The human will paste the unchanged lyrics into Suno's Lyrics field. Return ONLY compact JSON: {"decision":"READY|REVISE","reason":"specific judgment","stylePrompt":"English Suno style field text; empty when REVISE","qualityChecks":["what the human should listen for"]}.\nARTIST: ${JSON.stringify(ARTIST_BRIEF)}\nTITLE: ${input.title}\nLYRICS: ${input.lyrics.slice(0, 8000)}\nLYRIC REVIEW: ${input.lyricReview.slice(0, 2500)}\nPRODUCTION BRIEF: ${input.productionBrief.slice(0, 2500)}`
  );
  const result = parseModelJson(reply.text, sunoPreparationSchema);
  if (result.decision === "READY" && result.stylePrompt.trim().length < 80)
    throw new Error("SUNO_STYLE_PROMPT_TOO_SHORT");
  return result;
}

export async function auditSunoReturn(
  handoff: SunoHandoff,
  runModel: ModelRunner
): Promise<SunoAudit> {
  const submission = handoff.submission;
  if (!submission?.audioEvidence?.transcript.trim())
    throw new Error("AUDIO_TRANSCRIPT_REQUIRED");
  const reply = await runModel(
    "SUNO_AUDITOR",
    `You are an independent music release auditor. Assess the human-selected Suno result using the original lyrics, expected style, human listening observations, and the automated speech transcript. The transcript can be wrong, especially over music; never claim you listened to the audio or verified timbre, groove, mix, melody or emotional delivery directly. Credit those only to the human's notes and mark them as reported. Compare lyric fidelity and structure cautiously. Decide RELEASE_CANDIDATE only when the evidence is persuasive, the song fits the brief, and no material problem is reported. If the evidence is thin choose INSUFFICIENT_EVIDENCE. Give a concrete staged release and audience-feedback proposal, but do not publish, distribute, contact anyone, or claim rights have been verified. Return ONLY JSON with keys decision (RELEASE_CANDIDATE|REVISE|REJECT|INSUFFICIENT_EVIDENCE), summary, lyricFidelity, strengths (array), issues (array), uncertainties (array), releaseProposal (string).\nARTIST: ${JSON.stringify(ARTIST_BRIEF)}\nTITLE: ${handoff.title}\nORIGINAL LYRICS: ${handoff.lyrics.slice(0, 8000)}\nEXPECTED STYLE: ${handoff.preparation?.stylePrompt ?? ""}\nHUMAN NOTES (reported, not independently verified): ${submission.listeningNotes}\nTRANSCRIPT (automated, imperfect): ${submission.audioEvidence.transcript.slice(0, 10000)}\nRIGHTS BASIS REPORTED BY HUMAN: ${submission.rightsBasis}`
  );
  return parseModelJson(reply.text, sunoAuditSchema);
}
