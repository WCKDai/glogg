import React, { useState } from 'react';
import { api } from '../lib.js';

/** Shown over everything when this glogg has a password and there's no session. */
export function SignIn({ onDone }: { onDone: () => void }) {
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api('/api/auth/login', { method: 'POST', json: { password } });
      onDone();
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  };

  return (
    <div className="signin" role="dialog" aria-modal="true" aria-labelledby="signin-title">
      <form className="signin-card" onSubmit={submit}>
        <img src="/logo.png" alt="" width={36} height={36} />
        <h1 id="signin-title">This glogg is private</h1>
        <p>Enter its password to continue.</p>
        <input
          className="input"
          type="password"
          aria-label="Password"
          autoComplete="current-password"
          autoFocus
          value={password}
          onChange={(e) => setPassword(e.target.value)}
        />
        {error && (
          <p className="signin-error" role="alert">
            {error}
          </p>
        )}
        <button className="btn btn-primary" disabled={busy || !password}>
          {busy ? 'Signing in…' : 'Sign in'}
        </button>
      </form>
    </div>
  );
}
