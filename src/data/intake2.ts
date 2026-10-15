/**
 * Intake-2, "Site & Deployment Specification" — VFARM_BUYER_INTAKE.v1 as the
 * buyer sees it (2026-10-14, Destiny; Hardik's field list of 14 Oct in
 * #bha-coordination, VFARM_INTAKE_2_FIELD_LIST.md, from the locked contract's
 * section 1.B; Jason's go-ahead the same day: a unique-link page, not a Google
 * Form, writing onto the lead's existing record).
 *
 * **31 fields, 25 required, 6 optional, labels copied character for
 * character.** The label is the key an answer is stored under, so changing
 * one is a contract change: Hardik first, then here, then BUILD_LOG.
 * `id` is only the page's form-control name and is never stored.
 *
 * This is the one place the server (validation, the buyer page) and the Early
 * Access tab (display) read the fields from.
 *
 * A "Structured" field in the contract is a `group`: its parts are stored as
 * one object under the field's label, each part under its own label. Where
 * the contract says "Unknown allowed", the part is free text so a buyer can
 * write a number or "Unknown"; a part the contract leaves open is optional.
 */

export const INTAKE2_CONTRACT = 'VFARM_BUYER_INTAKE.v1';

export interface Intake2Part {
  key: string;
  label: string;
  kind: 'text' | 'number' | 'select' | 'multi' | 'month';
  options?: readonly string[];
  required?: boolean;
  hint?: string;
}

export type Intake2Field =
  | { n: number; id: string; label: string; required: boolean; kind: 'longtext'; hint?: string }
  | { n: number; id: string; label: string; required: boolean; kind: 'integer'; min: number }
  | {
      n: number;
      id: string;
      label: string;
      required: boolean;
      kind: 'select' | 'multi';
      options: readonly string[];
      /** A free-text box beside the choice; `when` limits it to one option (the "Other" text). */
      detail?: { label: string; when?: string; required?: boolean };
    }
  | { n: number; id: string; label: string; required: boolean; kind: 'group'; parts: readonly Intake2Part[] }
  | { n: number; id: string; label: string; required: boolean; kind: 'file' };

const UNITS_LEN = ['mm', 'cm', 'm', 'in', 'ft'] as const;
const YNU = ['Yes', 'No', 'Unknown'] as const;
const AVAIL = ['Available', 'Planned', 'Not available', 'Unknown'] as const;
const WHO = ['Buyer staff', 'Facility/operator partner', 'BHA involvement requested', 'Not decided', 'Other'] as const;
const NUM_OR_UNKNOWN = 'A number, or Unknown';

export const INTAKE2_FIELDS: readonly Intake2Field[] = [
  { n: 1, id: 'f1', label: 'What deployment outcome should this first vFarm installation support?', required: true, kind: 'longtext' },
  { n: 2, id: 'f2', label: 'Which unit type should BHA evaluate?', required: true, kind: 'select', options: ['Standard tomato P1.0 rack', 'Unsure — BHA to confirm fit'] },
  { n: 3, id: 'f3', label: 'How many racks should the feasibility review evaluate?', required: true, kind: 'integer', min: 1 },
  {
    n: 4,
    id: 'f4',
    label: 'How do you expect the racks to be arranged?',
    required: true,
    kind: 'select',
    options: ['Single row', 'Multiple rows', 'Along a wall/perimeter', 'Layout not yet decided', 'Other'],
    detail: { label: 'Describe the arrangement', when: 'Other', required: true },
  },
  { n: 5, id: 'f5', label: 'Upload a site sketch or marked-up floor plan, if available.', required: false, kind: 'file' },
  {
    n: 6,
    id: 'f6',
    label: 'Confirm the proposed installation site.',
    required: true,
    kind: 'group',
    parts: [
      { key: 'p1', label: 'Facility/site name', kind: 'text', required: true },
      { key: 'p2', label: 'Street or location reference', kind: 'text', required: true },
      { key: 'p3', label: 'City', kind: 'text', required: true },
      { key: 'p4', label: 'Region', kind: 'text', required: true },
      { key: 'p5', label: 'Country', kind: 'text', required: true },
    ],
  },
  {
    n: 7,
    id: 'f7',
    label: 'What clear installation footprint is available?',
    required: true,
    kind: 'group',
    parts: [
      { key: 'p1', label: 'Length', kind: 'number', required: true },
      { key: 'p2', label: 'Width', kind: 'number', required: true },
      { key: 'p3', label: 'Clear height', kind: 'number', required: true },
      { key: 'p4', label: 'Unit', kind: 'select', options: UNITS_LEN, required: true },
    ],
  },
  {
    n: 8,
    id: 'f8',
    label: 'What service clearance is available around the installation area?',
    required: true,
    kind: 'group',
    parts: [
      { key: 'p1', label: 'Front', kind: 'text', required: true, hint: NUM_OR_UNKNOWN },
      { key: 'p2', label: 'Left', kind: 'text', required: true, hint: NUM_OR_UNKNOWN },
      { key: 'p3', label: 'Right', kind: 'text', required: true, hint: NUM_OR_UNKNOWN },
      { key: 'p4', label: 'Rear', kind: 'text', required: true, hint: NUM_OR_UNKNOWN },
      { key: 'p5', label: 'Unit', kind: 'select', options: UNITS_LEN, required: true },
    ],
  },
  {
    n: 9,
    id: 'f9',
    label: 'Describe the floor, level and anchoring conditions.',
    required: true,
    kind: 'group',
    parts: [
      { key: 'p1', label: 'Level/floor', kind: 'text', required: true, hint: 'For example ground floor, level 2' },
      { key: 'p2', label: 'Floor surface', kind: 'text', required: true, hint: 'For example sealed concrete, tile' },
      { key: 'p3', label: 'Anchoring allowed', kind: 'select', options: YNU, required: true },
      { key: 'p4', label: 'Load concerns', kind: 'select', options: ['None known', 'Yes', 'Unknown'], required: true },
      { key: 'p5', label: 'Notes', kind: 'text' },
    ],
  },
  {
    n: 10,
    id: 'f10',
    label: 'Describe the delivery path from building entry to the installation area.',
    required: true,
    kind: 'group',
    parts: [
      { key: 'p1', label: 'Narrowest width', kind: 'text', required: true, hint: NUM_OR_UNKNOWN },
      { key: 'p2', label: 'Narrowest height', kind: 'text', required: true, hint: NUM_OR_UNKNOWN },
      { key: 'p3', label: 'Unit', kind: 'select', options: UNITS_LEN, required: true },
      { key: 'p4', label: 'Stairs', kind: 'select', options: ['Yes', 'No'], required: true },
      { key: 'p5', label: 'Freight/passenger lift', kind: 'select', options: ['Yes', 'No', 'Not applicable'], required: true },
      { key: 'p6', label: 'Loading access', kind: 'text', required: true, hint: 'For example loading dock, street parking, none' },
      { key: 'p7', label: 'Notes', kind: 'text' },
    ],
  },
  {
    n: 11,
    id: 'f11',
    label: 'Describe electrical service at the proposed installation point.',
    required: true,
    kind: 'group',
    parts: [
      { key: 'p1', label: 'Availability', kind: 'select', options: AVAIL, required: true },
      { key: 'p2', label: 'Voltage', kind: 'text', hint: 'Unknown is fine' },
      { key: 'p3', label: 'Phase', kind: 'text', hint: 'Unknown is fine' },
      { key: 'p4', label: 'Circuit/breaker rating', kind: 'text', hint: 'Unknown is fine' },
      { key: 'p5', label: 'Dedicated circuit', kind: 'select', options: YNU },
      { key: 'p6', label: 'Distance', kind: 'text', hint: 'From the installation point, with a unit' },
      { key: 'p7', label: 'Notes', kind: 'text' },
    ],
  },
  {
    n: 12,
    id: 'f12',
    label: 'Describe the water connection available at the proposed installation point.',
    required: true,
    kind: 'group',
    parts: [
      { key: 'p1', label: 'Availability', kind: 'select', options: AVAIL, required: true },
      { key: 'p2', label: 'Source/type', kind: 'text' },
      { key: 'p3', label: 'Potable', kind: 'select', options: YNU },
      { key: 'p4', label: 'Pressure/flow', kind: 'text', hint: 'If known' },
      { key: 'p5', label: 'Distance', kind: 'text', hint: 'From the installation point, with a unit' },
      { key: 'p6', label: 'Notes', kind: 'text' },
    ],
  },
  {
    n: 13,
    id: 'f13',
    label: 'How would water be drained or removed from the installation area?',
    required: true,
    kind: 'select',
    options: ['Floor drain', 'Sink/service drain', 'Contained collection/pump-out', 'No route identified', 'Unknown', 'Other'],
    detail: { label: 'Distance and notes' },
  },
  {
    n: 14,
    id: 'f14',
    label: 'Describe the indoor or protected conditions at the installation site.',
    required: true,
    kind: 'group',
    parts: [
      { key: 'p1', label: 'Conditions', kind: 'select', options: ['Fully indoor', 'Protected but not conditioned', 'Semi-exposed', 'Exposed', 'Unknown'], required: true },
      { key: 'p2', label: 'Weather exposure', kind: 'text' },
      { key: 'p3', label: 'Conditioned/HVAC', kind: 'select', options: YNU },
      { key: 'p4', label: 'Notes', kind: 'text' },
    ],
  },
  {
    n: 15,
    id: 'f15',
    label: 'What operating environment should the review account for?',
    required: true,
    kind: 'group',
    parts: [
      { key: 'p1', label: 'Expected minimum temperature', kind: 'text', hint: 'With a unit, or Unknown' },
      { key: 'p2', label: 'Expected maximum temperature', kind: 'text', hint: 'With a unit, or Unknown' },
      { key: 'p3', label: 'Expected minimum humidity', kind: 'text', hint: 'Percent, or Unknown' },
      { key: 'p4', label: 'Expected maximum humidity', kind: 'text', hint: 'Percent, or Unknown' },
      { key: 'p5', label: 'Ventilation', kind: 'text', required: true, hint: 'What moves air there, or Unknown' },
      { key: 'p6', label: 'Exposure', kind: 'multi', options: ['Dust', 'Pests', 'Chemicals', 'Salt/industrial exposure', 'None known', 'Unknown'], required: true },
    ],
  },
  {
    n: 16,
    id: 'f16',
    label: 'What facility approvals or permits are already known?',
    required: true,
    kind: 'multi',
    options: ['Owner approval', 'Landlord approval', 'Facilities approval', 'Electrical/plumbing permit', 'Food/licensing review', 'None identified', 'Unknown'],
    detail: { label: 'Details' },
  },
  { n: 17, id: 'f17', label: 'What installation access or work restrictions apply?', required: true, kind: 'longtext', hint: '"None known" is a fine answer.' },
  {
    n: 18,
    id: 'f18',
    label: 'What network connectivity is available at the installation area?',
    required: false,
    kind: 'multi',
    options: ['Ethernet', 'Wi-Fi', 'Cellular only', 'None', 'Unknown'],
    detail: { label: 'Notes' },
  },
  { n: 19, id: 'f19', label: 'Who would operate the rack day to day?', required: true, kind: 'select', options: WHO, detail: { label: 'Role and notes' } },
  { n: 20, id: 'f20', label: 'Who would own routine cleaning and maintenance responsibilities?', required: true, kind: 'select', options: WHO, detail: { label: 'Notes' } },
  {
    n: 21,
    id: 'f21',
    label: 'What monitoring or interaction does your team need?',
    required: true,
    kind: 'multi',
    options: ['On-site checks', 'Remote status', 'Alerts', 'Reporting', 'Data export', 'Training', 'Not sure'],
    detail: { label: 'Priority notes' },
  },
  {
    n: 22,
    id: 'f22',
    label: 'When could the site be ready for installation review?',
    required: true,
    kind: 'group',
    parts: [
      { key: 'p1', label: 'Date or month', kind: 'month', required: true },
      { key: 'p2', label: 'Confidence', kind: 'select', options: ['Target', 'Confirmed', 'Unknown'], required: true },
    ],
  },
  {
    n: 23,
    id: 'f23',
    label: 'What is the current internal approval and budget status?',
    required: true,
    kind: 'select',
    options: ['Exploratory', 'Budget range identified', 'Internal approval in progress', 'Approved subject to feasibility/terms', 'Unknown'],
    detail: { label: 'Notes' },
  },
  { n: 24, id: 'f24', label: 'Who must participate in a feasibility or commercial decision?', required: true, kind: 'longtext', hint: 'Roles, names and how each prefers to be contacted.' },
  { n: 25, id: 'f25', label: 'What currently blocks a site review or pilot decision?', required: true, kind: 'longtext', hint: '"No blocker known" is a fine answer.' },
  {
    n: 26,
    id: 'f26',
    label: 'Can your team provide structured operating feedback if a pilot review proceeds?',
    required: true,
    kind: 'select',
    options: ['Yes', 'No', 'Needs discussion'],
    detail: { label: 'Constraints' },
  },
  { n: 27, id: 'f27', label: 'What feasibility questions must BHA resolve?', required: false, kind: 'longtext' },
  { n: 28, id: 'f28', label: 'What pricing information or decision criteria do you need?', required: false, kind: 'longtext' },
  { n: 29, id: 'f29', label: 'What ownership or operating-responsibility questions must be resolved?', required: false, kind: 'longtext' },
  {
    n: 30,
    id: 'f30',
    label: 'What licensing or food-safety requirements are known for this site and intended use?',
    required: true,
    kind: 'group',
    parts: [
      { key: 'p1', label: 'Intended produce use', kind: 'select', options: ['Internal use', 'Sale', 'Service to public', 'Research or education', 'Not decided', 'Other'], required: true },
      { key: 'p2', label: 'Jurisdiction/authority', kind: 'text' },
      { key: 'p3', label: 'Known permit or food-safety requirements', kind: 'text' },
      { key: 'p4', label: 'Responsible contact', kind: 'text' },
      { key: 'p5', label: 'Notes', kind: 'text' },
    ],
  },
  { n: 31, id: 'f31', label: 'Upload supporting site, utility, approval or compliance documents, if available.', required: false, kind: 'file' },
];

/** Grouped for the page and the dashboard, in the list's own order. The titles are ours, not the contract's. */
export const INTAKE2_SECTIONS: { title: string; fields: number[] }[] = [
  { title: 'The installation', fields: [1, 2, 3, 4, 5] },
  { title: 'The site', fields: [6, 7, 8, 9, 10] },
  { title: 'Power, water and environment', fields: [11, 12, 13, 14, 15] },
  { title: 'Approvals and access', fields: [16, 17, 18] },
  { title: 'Operation', fields: [19, 20, 21] },
  { title: 'Timing and decision', fields: [22, 23, 24, 25, 26] },
  { title: 'Open questions and compliance', fields: [27, 28, 29, 30, 31] },
];

/** File limits for the two upload fields. */
export const INTAKE2_FILE_TYPES: Record<string, string> = { 'application/pdf': 'PDF', 'image/jpeg': 'JPG', 'image/png': 'PNG' };
export const INTAKE2_FILE_MAX_BYTES = 15 * 1024 * 1024;
export const INTAKE2_FILES_PER_FIELD = 5;

/** One stored file: a Drive file this server uploaded into the lead's folder. */
export interface Intake2File {
  file_id: string;
  name: string;
  mime: string;
  size: number;
  link: string | null;
}

/** What is stored in engine_vfarm_leads.intake_2. */
export interface Intake2Stored {
  contract: string;
  invite_id: string;
  submission_id: string;
  buyer_intake_id: string;
  early_access_lead_id: string | null;
  correlation_id: string | null;
  submitted_at: string;
  answers: Record<string, unknown>;
  /** Drive folder holding the uploads, when there were any. */
  drive_folder: { id: string; link: string | null } | null;
  digest: string;
  /** The buyer's receipt email, sent once on submit (15 Oct 2026). */
  confirmation_email?: Intake2Send | null;
}

/** The invite, stored in engine_vfarm_leads.intake_2_invite. The link is never stored, only its hash; `link` is added when the dashboard reads it. */
export interface Intake2Invite {
  invite_id: string;
  token_sha256: string;
  issued_at: string;
  issued_by: string;
  link: string;
  sends: Intake2Send[];
  opened_at: string | null;
  drive_folder: { id: string; link: string | null } | null;
  /** The two follow-up emails (15 Oct 2026): fu1 at 3 days, fu2 at 7. */
  followups?: Partial<Record<'fu1' | 'fu2', Intake2Send & { attempts?: number; claimed_at?: string }>>;
  /** Set at 14 days with no answer, after both follow-ups. Cleared by a person. */
  unresponsive_at?: string | null;
  unresponsive_alert?: { ts: string | null; error: string | null } | null;
  unresponsive_cleared?: { at: string; by: string; was: string | null }[];
}

export interface Intake2Send {
  send_id: string;
  at: string;
  by: string;
  to: string;
  outcome: 'sent' | 'failed';
  gmail_message_id: string | null;
  error: string | null;
}

/** Human-readable text for one stored answer, for the dashboard and the Slack alert. */
export function answerText(f: Intake2Field, v: unknown): string {
  if (v === null || v === undefined || v === '') return '';
  if (f.kind === 'longtext' || f.kind === 'integer') return String(v);
  if (f.kind === 'file') {
    const files = Array.isArray(v) ? (v as Intake2File[]) : [];
    return files.map((x) => x.name).join(', ');
  }
  if (f.kind === 'select' || f.kind === 'multi') {
    const o = (v ?? {}) as { choice?: string; choices?: string[]; detail?: string };
    const main = f.kind === 'select' ? o.choice ?? '' : (o.choices ?? []).join(', ');
    return o.detail ? `${main} (${o.detail})` : main;
  }
  if (f.kind !== 'group') return String(v);
  const o = (v ?? {}) as Record<string, unknown>;
  return f.parts
    .map((p) => {
      const x = o[p.label];
      if (x === null || x === undefined || x === '' || (Array.isArray(x) && !x.length)) return '';
      return `${p.label}: ${Array.isArray(x) ? x.join(', ') : String(x)}`;
    })
    .filter(Boolean)
    .join(' · ');
}

/**
 * The follow-up timing (15 Oct 2026, Destiny), counted from the first Form 2 email that went
 * out. The numbers live here and nowhere else: the server's sweep sends by them and the page's
 * tracker shows them, so the two cannot disagree about when a reminder is due.
 */
export const FOLLOW_UP = { first_days: 3, second_days: 7, unresponsive_days: 14, max_attempts: 3, tick_minutes: 15 } as const;

export interface FollowUpStep {
  key: 'sent' | 'fu1' | 'fu2' | 'unresponsive';
  label: string;
  /** done: it happened; failed: an email that did not go; due: it will happen on `at`; stopped: it will not happen. */
  state: 'done' | 'failed' | 'due' | 'stopped';
  at: string | null;
  note?: string;
}

const DAY_MS = 86_400_000;

/**
 * Where a lead's Form 2 follow-ups stand, as four steps: Form 2 sent, reminder 1, reminder 2,
 * marked unresponsive. A due date is the earliest the 15-minute sweep will act, using the same
 * spacing it uses (reminder 2 at least 4 days after reminder 1, unresponsive at least 7 after
 * reminder 2). Answering, or a closed lead, stops what has not happened.
 */
export function followUpPlan(inv: Omit<Intake2Invite, 'token_sha256'> | null | undefined, opts: { answered_at?: string | null; closed?: boolean } = {}): FollowUpStep[] | null {
  if (!inv) return null;
  const sent = (inv.sends ?? []).filter((s) => s.outcome === 'sent');
  const first = sent[0]?.at ?? null;
  const lastFail = (inv.sends ?? []).filter((s) => s.outcome === 'failed').slice(-1)[0];
  const stopNote = opts.answered_at ? 'not needed, they answered' : opts.closed ? 'stopped, lead closed' : null;
  const steps: FollowUpStep[] = [
    first
      ? { key: 'sent', label: 'Form 2 sent', state: 'done', at: first }
      : { key: 'sent', label: 'Form 2 sent', state: lastFail ? 'failed' : 'due', at: lastFail?.at ?? null, note: lastFail ? `did not go: ${lastFail.error}` : 'not sent yet' },
  ];
  const f = inv.followups ?? {};
  const start = first ? Date.parse(first) : null;
  const step = (key: 'fu1' | 'fu2', label: string, dueMs: number | null): FollowUpStep => {
    const x = f[key];
    if (x?.outcome === 'sent') return { key, label, state: 'done', at: x.at };
    if (x?.outcome === 'failed') return { key, label, state: 'failed', at: x.at, note: `did not go (try ${x.attempts ?? 1} of ${FOLLOW_UP.max_attempts}): ${x.error}` };
    if (stopNote || inv.unresponsive_at) return { key, label, state: 'stopped', at: null, note: stopNote ?? 'not sent' };
    return { key, label, state: 'due', at: dueMs === null ? null : new Date(dueMs).toISOString() };
  };
  const fu1Due = start === null ? null : start + FOLLOW_UP.first_days * DAY_MS;
  steps.push(step('fu1', 'Reminder 1', fu1Due));
  const fu1At = f.fu1?.at ? Date.parse(f.fu1.at) : null;
  const fu2Due = start === null ? null : Math.max(start + FOLLOW_UP.second_days * DAY_MS, (fu1At ?? fu1Due!) + (FOLLOW_UP.second_days - FOLLOW_UP.first_days) * DAY_MS);
  steps.push(step('fu2', 'Reminder 2', fu2Due));
  if (inv.unresponsive_at) steps.push({ key: 'unresponsive', label: 'Marked unresponsive', state: 'done', at: inv.unresponsive_at });
  else if (stopNote) steps.push({ key: 'unresponsive', label: 'Marked unresponsive', state: 'stopped', at: null, note: stopNote });
  else {
    const fu2At = f.fu2?.at ? Date.parse(f.fu2.at) : null;
    const due = start === null ? null : Math.max(start + FOLLOW_UP.unresponsive_days * DAY_MS, (fu2At ?? fu2Due!) + (FOLLOW_UP.unresponsive_days - FOLLOW_UP.second_days) * DAY_MS);
    steps.push({ key: 'unresponsive', label: 'Marked unresponsive', state: 'due', at: due === null ? null : new Date(due).toISOString(), note: 'if they have not answered' });
  }
  return steps;
}
