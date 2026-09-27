// Keep guest mode on this browser; it never grants account access.
export const GUEST_KEY = 'bstr-drive-guest-mode';

export function createLoginFlow({ start, isSignedIn, storage, onError }) {
  let pending = null;
  let syncStarted = false;
  let guest = false;
  try { guest = storage.getItem(GUEST_KEY) === '1'; } catch {}

  const rememberGuest = () => {
    guest = true;
    try { storage.setItem(GUEST_KEY, '1'); } catch {}
  };

  const requestSignIn = () => {
    if (pending) return pending;
    if (syncStarted && isSignedIn()) return Promise.resolve(true);
    pending = Promise.resolve().then(() => start({ onSkip: rememberGuest })).then(started => {
      if (started === true) {
        syncStarted = true;
        guest = false;
        try { storage.removeItem(GUEST_KEY); } catch {}
      }
      return started;
    }).catch(error => { onError(error); }).finally(() => { pending = null; });
    return pending;
  };

  return {
    requestSignIn,
    initialize() { if (isSignedIn()) return requestSignIn(); },
    onAllDocsClick(event) {
      if (event?.defaultPrevented || event?.ctrlKey || event?.metaKey || event?.shiftKey || event?.altKey) return;
      if (!isSignedIn() && !guest) return requestSignIn();
    },
  };
}
