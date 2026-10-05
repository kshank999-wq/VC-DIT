import { describe, expect, it } from 'vitest';
import { licenseIssued, licenseReminder } from '../email-templates';

describe('license email', () => {
  const input = { serial: 'VCDIT-AAAAA-BBBBB-CCCCC-DDDDD', planName: 'VC DIT', accountUrl: 'https://vc-dit.com/account', downloadUrl: 'https://vc-dit.com/download' };

  it('carries the authorization code and both links, in HTML and in text', () => {
    const email = licenseIssued(input);
    for (const body of [email.html, email.text]) {
      expect(body).toContain(input.serial);
      expect(body).toContain(input.accountUrl);
      expect(body).toContain(input.downloadUrl);
    }
    expect(email.subject).toBe('Your VC DIT authorization code');
    expect(`${email.template}@${email.version}`).toBe('dit-license-issued@1');
  });

  it('escapes what it is given', () => {
    expect(licenseIssued({ ...input, serial: '<b>x</b>' }).html).not.toContain('<b>x</b>');
    expect(licenseReminder(input).template).toBe('dit-license-reminder');
  });
});
