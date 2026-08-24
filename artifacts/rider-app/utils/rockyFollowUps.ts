export interface FollowUpChip {
  label: string;
  question: string;
}

const MAX_AI_CHIP_LENGTH = 40;

interface FollowUpTopic {
  keywords: string[];
  chips: FollowUpChip[];
}

const FOLLOW_UP_TOPICS: FollowUpTopic[] = [
  {
    keywords: ["suspension", "fork", "shock", "sag", "clicker", "rebound", "compression"],
    chips: [
      { label: "Check sag", question: "How do I check and set my sag correctly?" },
      { label: "Fork oil weight", question: "What fork oil weight should I run and how often should I change it?" },
      { label: "Bottoming out", question: "My suspension is bottoming out — how do I stiffen it up?" },
      { label: "Soft vs stiff", question: "Should I run softer or stiffer suspension for a hard-pack track?" },
    ],
  },
  {
    keywords: ["arm pump", "forearms", "grip", "arms", "pump"],
    chips: [
      { label: "Grip strength", question: "What exercises help reduce arm pump?" },
      { label: "Grip pressure", question: "How tight should I grip the handlebars?" },
      { label: "Bar setup", question: "Can bar height or position affect arm pump?" },
      { label: "Hydration", question: "Does hydration affect arm pump on race day?" },
    ],
  },
  {
    keywords: ["corner", "turn", "berm", "rut", "inside", "line"],
    chips: [
      { label: "Body position", question: "What body position should I use in berms?" },
      { label: "Braking point", question: "Where should I brake before a corner?" },
      { label: "Ruts", question: "How do I ride rutted corners faster?" },
      { label: "Exit drive", question: "How do I get better drive off corners?" },
    ],
  },
  {
    keywords: ["jetting", "carburetor", "carb", "fuel", "rich", "lean", "four-stroke", "two-stroke"],
    chips: [
      { label: "Rich vs lean", question: "How can I tell if I'm running rich or lean?" },
      { label: "Altitude changes", question: "How should I re-jet for high altitude racing?" },
      { label: "Main jet", question: "When should I go up or down a main jet size?" },
      { label: "Pilot jet", question: "What does the pilot jet affect and when should I change it?" },
    ],
  },
  {
    keywords: ["start", "holeshot", "gate", "launch", "clutch", "rev"],
    chips: [
      { label: "Clutch control", question: "How should I modulate the clutch at the start?" },
      { label: "Gate pick", question: "How do I pick the best gate position?" },
      { label: "Traction tip", question: "How do I prevent wheelies or wheelspin off the gate?" },
      { label: "Rev range", question: "What RPM range should I launch from?" },
    ],
  },
  {
    keywords: ["maintenance", "oil", "filter", "chain", "sprocket", "brake", "tire", "tyre", "wheel"],
    chips: [
      { label: "Oil intervals", question: "How often should I change the oil on my bike?" },
      { label: "Air filter", question: "How often should I clean my air filter?" },
      { label: "Chain tension", question: "How tight should my chain be and how do I adjust it?" },
      { label: "Brake pads", question: "How do I know when my brake pads need replacing?" },
    ],
  },
];

const FALLBACK_FOLLOW_UPS: FollowUpChip[] = [
  { label: "Suspension tune", question: "How do I tune my suspension for my riding style?" },
  { label: "Go faster", question: "What's the single biggest thing I can do to ride faster?" },
  { label: "Race prep", question: "What should I do the week before a race?" },
  { label: "Common mistakes", question: "What are the most common beginner mistakes to avoid?" },
];

export function getKeywordFollowUpChips(lastUserMessage: string): FollowUpChip[] {
  const lowerCaseMessage = lastUserMessage.toLowerCase();
  const matchingTopic = FOLLOW_UP_TOPICS.find((topic) =>
    topic.keywords.some((keyword) => lowerCaseMessage.includes(keyword)),
  );

  return matchingTopic?.chips ?? FALLBACK_FOLLOW_UPS;
}

export function aiSuggestionsToChips(
  suggestions: string[],
): FollowUpChip[] | null {
  const chips = suggestions
    .map((suggestion) => suggestion.trim())
    .filter(
      (suggestion) =>
        suggestion.length > 0 && suggestion.length <= MAX_AI_CHIP_LENGTH,
    )
    .map((question) => ({ label: question, question }));

  return chips.length > 0 ? chips : null;
}

export function resolveFollowUpChips(
  suggestedFollowUps: string[],
  lastUserMessage: string,
): FollowUpChip[] {
  return (
    aiSuggestionsToChips(suggestedFollowUps) ??
    getKeywordFollowUpChips(lastUserMessage)
  );
}