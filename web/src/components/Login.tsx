import { useEffect, useState } from 'react';
import { startAuthentication } from '@simplewebauthn/browser';
import { api } from '../lib/api';
import { useStore } from '../lib/store';
import Icon from './Icon';

export default function Login({ onAuthed }: { onAuthed: () => void }) {
  const setMustChangePassword = useStore((s) => s.setMustChangePassword);
  const [needSetup, setNeedSetup] = useState(false);
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [code, setCode] = useState('');
  const [twoFactorToken, setTwoFactorToken] = useState('');
  const [passkeyEnabled, setPasskeyEnabled] = useState(false);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api.authStatus().then((s) => {
      setNeedSetup(!s.passwordSet);
      setPasskeyEnabled(s.passkeyEnabled);
    }).catch(() => {});
  }, []);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setErr('');
    if (needSetup && password !== confirm) {
      setErr('Passwords do not match');
      return;
    }
    setBusy(true);
    try {
      if (needSetup) {
        await api.setup(password);
        setMustChangePassword(false); // a freshly-set password is already custom
      } else {
        const r = await api.login(password);
        if (r.requiresTwoFactor) {
          setTwoFactorToken(r.twoFactorToken);
          setPassword('');
          return;
        }
        setMustChangePassword(Boolean(r.mustChangePassword));
      }
      onAuthed();
    } catch (e: any) {
      setErr(e.message ?? 'Failed');
    } finally {
      setBusy(false);
    }
  };

  const submitSecondFactor = async (e: React.FormEvent) => {
    e.preventDefault();
    setErr('');
    setBusy(true);
    try {
      await api.loginTotp(twoFactorToken, code);
      onAuthed();
    } catch (e: any) {
      setErr(e.message ?? 'Verification failed');
    } finally {
      setBusy(false);
    }
  };

  const loginWithPasskey = async () => {
    setErr('');
    setBusy(true);
    try {
      const { ceremonyId, options } = await api.passkeyLoginOptions();
      const response = await startAuthentication({ optionsJSON: options });
      await api.passkeyLoginVerify(ceremonyId, response);
      onAuthed();
    } catch (e: any) {
      if (e?.name !== 'NotAllowedError') setErr(e.message ?? 'Passkey login failed');
    } finally {
      setBusy(false);
    }
  };

  if (twoFactorToken) {
    return (
      <div className="login-screen">
        <form className="login-card" onSubmit={submitSecondFactor}>
          <div className="logo"><Icon name="shield-check" size={40} /></div>
          <h1>Two-factor authentication</h1>
          <p>Enter the 6-digit code from your authenticator app or a recovery code.</p>
          <div className="err">{err}</div>
          <input
            className="text-input"
            inputMode="numeric"
            autoComplete="one-time-code"
            placeholder="Verification or recovery code"
            autoFocus
            value={code}
            onChange={(e) => setCode(e.target.value)}
          />
          <button className="btn" type="submit" disabled={busy || !code.trim()}>
            {busy ? 'Verifying…' : 'Verify & Unlock'}
          </button>
          <button
            className="login-link"
            type="button"
            onClick={() => { setTwoFactorToken(''); setCode(''); setErr(''); }}
          >
            Back to password
          </button>
        </form>
      </div>
    );
  }

  return (
    <div className="login-screen">
      <form className="login-card" onSubmit={submit}>
        <div className="logo">
          <Icon name="gem" size={40} />
        </div>
        <h1>WebObsidian</h1>
        <p>{needSetup ? 'Set a master password to secure your vault' : 'Enter your password to unlock'}</p>
        <div className="err">{err}</div>
        <input
          className="text-input"
          type="password"
          placeholder="Password"
          autoFocus
          value={password}
          onChange={(e) => setPassword(e.target.value)}
        />
        {needSetup && (
          <input
            className="text-input"
            type="password"
            placeholder="Confirm password"
            value={confirm}
            onChange={(e) => setConfirm(e.target.value)}
          />
        )}
        {needSetup && password.length > 0 && password.length < 12 && (
          <div className="err">Password must be at least 12 characters</div>
        )}
        <button className="btn" type="submit" disabled={busy || (needSetup && password.length < 12)}>
          {busy ? 'Please wait…' : needSetup ? 'Create & Unlock' : 'Unlock'}
        </button>
        {!needSetup && passkeyEnabled && typeof window.PublicKeyCredential !== 'undefined' && (
          <>
            <div className="login-divider"><span>or</span></div>
            <button className="btn secondary" type="button" onClick={loginWithPasskey} disabled={busy}>
              <Icon name="key-round" size={16} /> Sign in with a Passkey
            </button>
          </>
        )}
      </form>
    </div>
  );
}
