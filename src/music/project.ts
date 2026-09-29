export const MUSIC_PROGRAM_ID = "original-soul-artist-v1";

export const ARTIST_BRIEF = {
  workingName: "Artist name to be chosen",
  language: "English",
  direction: "Alternative soul with hip-hop and trap influences",
  voice:
    "Warm, darker tone with a rough edge; intimate verses and powerful, emotionally earned choruses",
  writing:
    "Honest self-observation, conflicting feelings, sharp humor, concrete scenes and memorable lines",
  sound:
    "Piano, dry electric guitar, warm bass, restrained 808s and trap hi-hats, with occasional gospel-inspired backing vocals",
  songTest:
    "Every song needs a clear emotional statement, one distinctive line and a chorus that still works with only piano or guitar",
  originality:
    "Create original lyrics, melodies, voice identity and visual concepts. References describe qualities, never an artist to imitate or clone.",
  workflow: [
    "artist identity and song brief",
    "songwriting and topline draft",
    "production and vocal direction",
    "independent artistic review",
    "human Suno demo with the approved lyrics and style prompt",
    "recording audit against a human listening report and audio transcript",
    "release proposal and human approval",
    "audience feedback and next iteration"
  ]
} as const;

export const MUSIC_SPECIALIST_ROLES = [
  "SONGWRITER",
  "LYRICS_EXPERT",
  "PRODUCER",
  "VOCAL_DIRECTOR",
  "A_AND_R",
  "ART_DIRECTOR",
  "RELEASE_PLANNER",
  "MARKETING_STRATEGIST",
  "DISTRIBUTION_MANAGER",
  "MONETIZATION_ANALYST",
  "RESEARCHER",
  "AUDITOR"
] as const;

export function musicArtifactKind(
  role: string,
  content?: string
): string | null {
  if (content?.trimStart().startsWith("{")) {
    try {
      const parsed: unknown = JSON.parse(content);
      if (
        parsed &&
        typeof parsed === "object" &&
        "kind" in parsed &&
        parsed.kind === "artist_identity_card"
      )
        return "ARTIST_PROFILE";
      if (parsed && typeof parsed === "object" && "kind" in parsed) {
        if (parsed.kind === "lyric_review") return "LYRIC_REVIEW";
        if (parsed.kind === "song_revision") return "SONG_REVISION";
      }
    } catch {
      // Plain-text drafts continue to use the specialist's artifact type.
    }
  }
  switch (role) {
    case "SONGWRITER":
      return "SONG_DRAFT";
    case "LYRICS_EXPERT":
      return "LYRIC_REVIEW";
    case "PRODUCER":
      return "PRODUCTION_BRIEF";
    case "VOCAL_DIRECTOR":
      return "VOCAL_BRIEF";
    case "A_AND_R":
    case "AUDITOR":
      return "ARTISTIC_REVIEW";
    case "ART_DIRECTOR":
      return "ARTWORK_BRIEF";
    case "MARKETING_STRATEGIST":
      return "MARKETING_PLAN";
    case "DISTRIBUTION_MANAGER":
      return "DISTRIBUTION_PLAN";
    case "MONETIZATION_ANALYST":
      return "MONETIZATION_REVIEW";
    case "RELEASE_PLANNER":
      return "RELEASE_PLAN";
    default:
      return null;
  }
}
