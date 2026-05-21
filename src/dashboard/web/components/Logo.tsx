// The logo lives in one place: `src/dashboard/web/logo.svg`. This component
// inlines it so it can inherit `currentColor` from the surrounding element.

import svg from '../logo.svg';

interface Props {
  size?: number;
  className?: string;
}

export function Logo({ size = 28, className }: Props) {
  return (
    <span
      role="img"
      aria-label="botmux"
      className={className}
      style={{
        width: size,
        height: size,
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
      }}
      dangerouslySetInnerHTML={{ __html: svg }}
    />
  );
}
