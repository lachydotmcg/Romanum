/** Roblox's tilted-square mark identifies the sign-in provider, not Romanum. */
export function RobloxLogo({ className = "" }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true" focusable="false" className={className}>
      <path fillRule="evenodd" clipRule="evenodd" d="M2.2 2.2h19.6v19.6H2.2V2.2Zm7.2 7.2v5.2h5.2V9.4H9.4Z" transform="rotate(15 12 12)" />
    </svg>
  );
}
