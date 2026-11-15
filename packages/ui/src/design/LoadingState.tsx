export interface LoadingStateProps {
  label: string;
  /** Inline keeps the surrounding controls and any previous results in place during a refresh. */
  inline?: boolean;
  className?: string;
}

/** Shared progress for a read that has not answered; empty and error states belong to settled reads. */
export function LoadingState({ label, inline, className }: LoadingStateProps): JSX.Element {
  return (
    <span className={['ow-loading', inline ? 'ow-loading-inline' : '', className].filter(Boolean).join(' ')} role="status" aria-busy="true">
      <span className="ow-loading-mark" aria-hidden="true" />
      <span>{label}</span>
    </span>
  );
}
