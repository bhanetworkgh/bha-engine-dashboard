import { forwardRef, type AnchorHTMLAttributes, type ButtonHTMLAttributes, type ReactNode } from 'react';
import { Link, type LinkProps } from 'react-router-dom';

/**
 * The one button (2026-09-23, Destiny). Every clickable action in the app is
 * this component, or `ButtonLink` where it navigates, so the four variants and
 * their states are defined once in index.css (`.btn-*`) and cannot drift page
 * by page.
 *
 *   primary      gold, near-black label. **One per panel**: the single thing
 *                the panel is for (Save, Confirm, New loop).
 *   secondary    panel with a hairline ring — the quiet default. Resync, Open,
 *                Export, Cancel.
 *   ghost        no fill until hovered. Row actions, "Show more", filters.
 *   destructive  filled red. Delete, and nothing that can be undone.
 *
 * Hover, `:focus-visible` (the 2px accent ring at 2px offset), disabled (0.5
 * opacity, no hover, no press) and loading (a spinner in front of the label,
 * `aria-busy`, and the button refuses the click) are all states of the same
 * element, never a second component.
 */
export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'destructive';
export type ButtonSize = 'md' | 'sm';

export function buttonClass(variant: ButtonVariant = 'secondary', size: ButtonSize = 'md', extra = ''): string {
  const v = variant === 'primary' ? 'btn-primary' : variant === 'ghost' ? 'btn-ghost' : variant === 'destructive' ? 'btn-danger' : 'btn-secondary';
  return ['btn', v, size === 'sm' ? 'btn-sm' : '', extra].filter(Boolean).join(' ');
}

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  /** Shows the spinner, sets aria-busy and ignores clicks. */
  loading?: boolean;
  /** An icon in front of the label. */
  icon?: ReactNode;
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = 'secondary', size = 'md', loading = false, icon, className = '', type = 'button', disabled, onClick, children, ...rest },
  ref,
) {
  return (
    <button
      ref={ref}
      type={type}
      className={buttonClass(variant, size, className)}
      disabled={disabled}
      aria-busy={loading || undefined}
      onClick={loading ? (e) => e.preventDefault() : onClick}
      {...rest}
    >
      {loading ? <span className="btn-spinner" aria-hidden /> : icon}
      {children}
    </button>
  );
});

/** A navigation that looks like a button: a router Link with the same classes. */
export function ButtonLink({ variant = 'secondary', size = 'md', className = '', icon, children, ...rest }: LinkProps & { variant?: ButtonVariant; size?: ButtonSize; icon?: ReactNode }) {
  return (
    <Link className={buttonClass(variant, size, className)} {...rest}>
      {icon}
      {children}
    </Link>
  );
}

/** An external link that looks like a button (a Slack message, an n8n execution, a memo). */
export function ButtonAnchor({ variant = 'secondary', size = 'md', className = '', icon, children, ...rest }: AnchorHTMLAttributes<HTMLAnchorElement> & { variant?: ButtonVariant; size?: ButtonSize; icon?: ReactNode }) {
  return (
    <a className={buttonClass(variant, size, className)} {...rest}>
      {icon}
      {children}
    </a>
  );
}
