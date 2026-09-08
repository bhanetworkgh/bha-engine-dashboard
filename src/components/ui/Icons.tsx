/**
 * Line icons for the sidebar and a few controls. 1.5px strokes on a 16px grid,
 * all drawn here so nothing external is loaded.
 */
import type { SVGProps } from 'react';

const base: SVGProps<SVGSVGElement> = {
  width: 16,
  height: 16,
  viewBox: '0 0 16 16',
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 1.5,
  strokeLinecap: 'round',
  strokeLinejoin: 'round',
  'aria-hidden': true,
};

export const Icon = {
  overview: (p: SVGProps<SVGSVGElement>) => (
    <svg {...base} {...p}>
      <rect x="2" y="2" width="5" height="5" rx="1.2" />
      <rect x="9" y="2" width="5" height="5" rx="1.2" />
      <rect x="2" y="9" width="5" height="5" rx="1.2" />
      <rect x="9" y="9" width="5" height="5" rx="1.2" />
    </svg>
  ),
  chat: (p: SVGProps<SVGSVGElement>) => (
    <svg {...base} {...p}>
      <path d="M2.5 4.5A2 2 0 0 1 4.5 2.5h7a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2H7l-3.2 2.4V11.5h-.3a1 1 0 0 1-1-1z" />
    </svg>
  ),
  star: (p: SVGProps<SVGSVGElement>) => (
    <svg {...base} {...p}>
      <path d="M8 2l1.7 3.6 3.9.5-2.9 2.7.8 3.9L8 10.8l-3.5 1.9.8-3.9L2.4 6.1l3.9-.5z" />
    </svg>
  ),
  twin: (p: SVGProps<SVGSVGElement>) => (
    <svg {...base} {...p}>
      <circle cx="6" cy="8" r="3.5" />
      <circle cx="10" cy="8" r="3.5" />
    </svg>
  ),
  leaf: (p: SVGProps<SVGSVGElement>) => (
    <svg {...base} {...p}>
      <path d="M13 3c-6 0-9.5 3-9.5 8 0 .8.1 1.5.3 2 5 0 9.2-3.4 9.2-10z" />
      <path d="M3.8 13c1.5-3.5 4-6 7-7.8" />
    </svg>
  ),
  pulse: (p: SVGProps<SVGSVGElement>) => (
    <svg {...base} {...p}>
      <path d="M1.5 8h3l1.5-4 3 8 1.5-4h4" />
    </svg>
  ),
  loop: (p: SVGProps<SVGSVGElement>) => (
    <svg {...base} {...p}>
      <path d="M13 8a5 5 0 0 1-8.6 3.5" />
      <path d="M3 8a5 5 0 0 1 8.6-3.5" />
      <path d="M11.5 2v2.8h-2.8M4.5 14v-2.8h2.8" />
    </svg>
  ),
  book: (p: SVGProps<SVGSVGElement>) => (
    <svg {...base} {...p}>
      <path d="M3 3.5A1.5 1.5 0 0 1 4.5 2H13v10.5H4.5A1.5 1.5 0 0 0 3 14z" />
      <path d="M3 12.5A1.5 1.5 0 0 1 4.5 11H13" />
    </svg>
  ),
  pattern: (p: SVGProps<SVGSVGElement>) => (
    <svg {...base} {...p}>
      <path d="M2 4h12M2 8h8M2 12h12" />
    </svg>
  ),
  tag: (p: SVGProps<SVGSVGElement>) => (
    <svg {...base} {...p}>
      <path d="M2 2.5h5.5L14 9l-5 5-6.5-6.5z" />
      <circle cx="5.5" cy="6" r="1" />
    </svg>
  ),
  people: (p: SVGProps<SVGSVGElement>) => (
    <svg {...base} {...p}>
      <circle cx="6" cy="5.5" r="2.5" />
      <path d="M1.5 13.5c0-2.5 2-4 4.5-4s4.5 1.5 4.5 4" />
      <path d="M10.5 3.5a2.3 2.3 0 0 1 0 4M12 9.8c1.6.5 2.5 1.8 2.5 3.7" />
    </svg>
  ),
  sun: (p: SVGProps<SVGSVGElement>) => (
    <svg {...base} {...p}>
      <circle cx="8" cy="8" r="3" />
      <path d="M8 1.5v1.5M8 13v1.5M1.5 8H3M13 8h1.5M3.4 3.4l1 1M11.6 11.6l1 1M3.4 12.6l1-1M11.6 4.4l1-1" />
    </svg>
  ),
  moon: (p: SVGProps<SVGSVGElement>) => (
    <svg {...base} {...p}>
      <path d="M13.5 9.5A6 6 0 0 1 6.5 2.5a6 6 0 1 0 7 7z" />
    </svg>
  ),
  menu: (p: SVGProps<SVGSVGElement>) => (
    <svg {...base} {...p}>
      <path d="M2.5 4.5h11M2.5 8h11M2.5 11.5h11" />
    </svg>
  ),
  close: (p: SVGProps<SVGSVGElement>) => (
    <svg {...base} {...p}>
      <path d="M4 4l8 8M12 4l-8 8" />
    </svg>
  ),
  arrow: (p: SVGProps<SVGSVGElement>) => (
    <svg {...base} {...p}>
      <path d="M3 8h10M9 4l4 4-4 4" />
    </svg>
  ),
  send: (p: SVGProps<SVGSVGElement>) => (
    <svg {...base} {...p}>
      <path d="M8 13V3M4 7l4-4 4 4" />
    </svg>
  ),
  plus: (p: SVGProps<SVGSVGElement>) => (
    <svg {...base} {...p}>
      <path d="M8 3v10M3 8h10" />
    </svg>
  ),
  search: (p: SVGProps<SVGSVGElement>) => (
    <svg {...base} {...p}>
      <circle cx="7" cy="7" r="4.5" />
      <path d="M10.5 10.5L14 14" />
    </svg>
  ),
  check: (p: SVGProps<SVGSVGElement>) => (
    <svg {...base} {...p}>
      <path d="M3 8.5l3 3 7-7" />
    </svg>
  ),
  chevron: (p: SVGProps<SVGSVGElement>) => (
    <svg {...base} {...p}>
      <path d="M6 3.5L10.5 8 6 12.5" />
    </svg>
  ),
  calendar: (p: SVGProps<SVGSVGElement>) => (
    <svg {...base} {...p}>
      <rect x="2" y="3" width="12" height="11" rx="2" />
      <path d="M2 6.5h12M5.5 1.5v3M10.5 1.5v3" />
    </svg>
  ),
  bolt: (p: SVGProps<SVGSVGElement>) => (
    <svg {...base} {...p}>
      <path d="M9 1.5L3.5 9h4l-.5 5.5L12.5 7h-4z" />
    </svg>
  ),
  shield: (p: SVGProps<SVGSVGElement>) => (
    <svg {...base} {...p}>
      <path d="M8 1.5l5.5 2v4c0 3.5-2.3 6-5.5 7-3.2-1-5.5-3.5-5.5-7v-4z" />
      <path d="M5.5 8l1.8 1.8L10.8 6" />
    </svg>
  ),
  sparkle: (p: SVGProps<SVGSVGElement>) => (
    <svg {...base} {...p}>
      <path d="M8 2l1.4 3.6L13 7l-3.6 1.4L8 12l-1.4-3.6L3 7l3.6-1.4z" />
      <path d="M12.5 11.5l.6 1.4 1.4.6-1.4.6-.6 1.4-.6-1.4-1.4-.6 1.4-.6z" />
    </svg>
  ),
  lock: (p: SVGProps<SVGSVGElement>) => (
    <svg {...base} {...p}>
      <rect x="3" y="7" width="10" height="7" rx="1.5" />
      <path d="M5.5 7V5a2.5 2.5 0 0 1 5 0v2" />
    </svg>
  ),
};

export type IconName = keyof typeof Icon;
