import React, { Suspense, useEffect, useState } from 'react';

/** Mounts (and code-loads) children the first time `when` becomes true, then keeps them mounted so exit animations still work. */
export default function LazyMount({ when, children }: { when: boolean; children: React.ReactNode }) {
  const [seen, setSeen] = useState(when);
  useEffect(() => { if (when) setSeen(true); }, [when]);
  return seen ? <Suspense fallback={null}>{children}</Suspense> : null;
}
