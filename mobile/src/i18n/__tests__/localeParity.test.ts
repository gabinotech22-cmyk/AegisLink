import en from '../locales/en.json';
import es from '../locales/es.json';
import itLocale from '../locales/it.json';

type LocaleTree = { [key: string]: string | LocaleTree };

function flattenKeys(obj: LocaleTree, prefix = ''): string[] {
  return Object.entries(obj).flatMap(([key, value]) => {
    const path = prefix ? `${prefix}.${key}` : key;
    return typeof value === 'string' ? [path] : flattenKeys(value, path);
  });
}

const locales: Record<string, LocaleTree> = { en, es, it: itLocale };

describe('i18n locale parity', () => {
  const enKeys = flattenKeys(en).sort();

  it.each(['es', 'it'])('%s has exactly the same keys as en', (loc) => {
    const keys = flattenKeys(locales[loc]).sort();
    expect(keys).toEqual(enKeys);
  });

  it('no locale has empty translations', () => {
    for (const [loc, tree] of Object.entries(locales)) {
      for (const key of flattenKeys(tree)) {
        const value = key.split('.').reduce<LocaleTree | string>(
          (node, part) => (node as LocaleTree)[part],
          tree,
        );
        expect({ loc, key, empty: value === '' }).toEqual({ loc, key, empty: false });
      }
    }
  });

  // Regression for TestFlight build 15: the add-contact flow was hardcoded in
  // Spanish. Every key the flow uses must exist in all three locales.
  it('add-contact flow keys exist in every locale', () => {
    const required = [
      'addContact.title',
      'addContact.intro',
      'addContact.qrLabel',
      'addContact.qrSub',
      'addContact.qrCta',
      'addContact.recommended',
      'addContact.linkLabel',
      'addContact.linkSub',
      'addContact.linkCta',
      'addContact.idLabel',
      'addContact.idSub',
      'addContact.idCta',
      'addContact.verifyWarningTitle',
      'addContact.verifyWarningBody',
      'addContact.myQrTitle',
      'addContact.showQrIntro',
      'addContact.yourAegisId',
      'addContact.scanContactQr',
      'addContact.scanContactQrA11y',
      'addContact.cancelScanA11y',
      'addContact.mitmTitle',
      'addContact.mitmDesc',
      'addContact.trustQR',
      'addContact.invalidQrTitle',
      'addContact.invalidQrDesc',
      'addContact.addedTitle',
      'addContact.verifiedBadge',
      'addContact.unverifiedBadge',
      'addContact.verifyHint',
      'addContact.openChat',
      'addContact.openChatA11y',
      'addContact.linkTitle',
      'addContact.linkIntro',
      'addContact.yourLinkLabel',
      'addContact.copyLink',
      'addContact.copyLinkA11y',
      'addContact.copied',
      'addContact.copiedA11y',
      'addContact.share',
      'addContact.shareA11y',
      'addContact.shareMessage',
      'addContact.linkWarning',
      'addContact.idIntro',
      'addContact.pasteA11y',
      'addContact.invalidFormat',
      'addContact.nicknameLabel',
      'addContact.nicknamePlaceholder',
      'addContact.adding',
      'addContact.networkError',
      'scanQR.title',
      'scanQR.instruction',
      'scanQR.invalidTitle',
      'scanQR.invalidDesc',
      'scanQR.mitmTitle',
      'scanQR.mitmDesc',
      'scanQR.acceptNewKey',
      'scanQR.permNeededTitle',
      'scanQR.permNeededDesc',
      'scanQR.allowCameraBtn',
      'scanQR.networkError',
      'scanQR.addError',
      'scanQR.adding',
      'verify.contactNotFound',
      'common.back',
      'common.cancel',
      'common.ok',
      'common.error',
    ];
    for (const [loc, tree] of Object.entries(locales)) {
      const keys = new Set(flattenKeys(tree));
      const missing = required.filter((k) => !keys.has(k));
      expect({ loc, missing }).toEqual({ loc, missing: [] });
    }
  });
});
