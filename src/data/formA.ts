/**
 * Hardik's Google Form A — "vFarm Early Access - Founding Buyer / Pilot
 * Interest" — as this dashboard knows it (2026-09-23).
 *
 * Every vFarm Early Access lead now arrives through Form A, either directly or
 * from the bhanetwork.org/vfarm form, which writes into Form A's response
 * sheet. Hardik's n8n tracker posts each one to POST /api/engine/vfarm-leads
 * with the answers keyed by their question text, and this file is the one
 * place both the server (which reports questions it did not expect) and the
 * Early Access tab (which groups the answers) read that text from.
 *
 * **The question text is copied character for character** from the response
 * sheet's column headers, as the n8n "vFarm Early Access — Website Intake"
 * workflow writes them — two of them end in a space, because Form A created
 * them that way, and a key without the space is a different key. Timestamp is
 * the sheet's own column, not a question, so it is not in this list.
 *
 * **The groups are NOT confirmed as Form A's own sections.** Neither n8n
 * workflow, the response sheet nor anything this dashboard can read names the
 * form's sections, so these are grouped by subject in the form's own question
 * order, and each title says what the questions are about rather than
 * claiming to be the form's heading. When somebody reads the real section
 * titles off the form, they replace these here and nowhere else.
 */

export const FORM_A_GROUPS: { title: string; questions: string[] }[] = [
  {
    title: 'Who they are',
    questions: ['Full name', 'Email address', 'Organization / household name', 'Which best describes you or your organization?'],
  },
  {
    title: 'Where',
    questions: ['City', 'State / Province / Region', 'Country'],
  },
  {
    title: 'What they want vFarm for',
    questions: ['What is your primary use case for vFarm?', 'What would you like vFarm to help you accomplish?'],
  },
  {
    title: 'The site',
    questions: [
      'Approximately how much space could you make available?',
      'Do you have an indoor or protected space available?',
      'Is electrical power available near the potential installation area?',
      'Is a water source available near the potential installation area?',
      'What type of environment would the first vFarm most likely operate in? ',
      'Are there any site constraints we should know about?',
      'How would you most want to monitor or interact with your vFarm?',
    ],
  },
  {
    title: 'Interest, timing and budget',
    questions: [
      'How serious is your interest in becoming an early vFarm buyer or pilot partner? ',
      'When could you realistically consider a vFarm pilot or purchase?',
      'Which best describes your current budget readiness?',
      'Would you consider a small Early Access reservation commitment in exchange for priority consideration as pilot units become available?',
      'Would you be willing to provide structured feedback during an Early Access pilot?',
    ],
  },
  {
    title: 'Anything else',
    questions: ["Anything else you'd like us to know?", 'How did you hear about vFarm?'],
  },
];

/** The 23 answers, in the form's order. */
export const FORM_A_QUESTIONS: string[] = FORM_A_GROUPS.flatMap((g) => g.questions);
