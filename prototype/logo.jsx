// AegisLink — Logo / brand mark used across screens

function AegisMark({ t, size = 32, mono = false }) {
  // A hex shield with two horizontal chain bars in negative space
  const stroke = mono ? 'currentColor' : t.accent;
  const fill = mono ? 'currentColor' : t.accent;
  return (
    <svg width={size} height={size} viewBox="0 0 40 40" fill="none" style={{ display: 'block' }}>
      <path d="M20 2 L35 10 L35 30 L20 38 L5 30 L5 10 Z"
            stroke={stroke} strokeWidth="2.4" strokeLinejoin="round"/>
      <rect x="13" y="15" width="14" height="3.2" rx="0.4" fill={fill}/>
      <rect x="13" y="21.8" width="14" height="3.2" rx="0.4" fill={fill} opacity="0.55"/>
    </svg>
  );
}

function AegisWord({ t, size = 22, compact = false }) {
  // Wordmark — classic Garamond-style serif (roman, not italic) for both directions.
  // This is the "logo lockup" wordmark, independent of the rest of the type system.
  return (
    <span style={{
      fontFamily: '"EB Garamond", "Garamond", "Times New Roman", serif',
      fontWeight: 500,
      fontSize: size,
      letterSpacing: '-0.005em',
      fontStyle: 'normal',
      color: t.text,
      lineHeight: 1,
    }}>
      {compact ? 'Aegis' : 'AegisLink'}
    </span>
  );
}

Object.assign(window, { AegisMark, AegisWord });
