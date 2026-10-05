import { Resend } from 'resend';
import { env } from './env';
import { licenseIssued, licenseReminder, type RenderedEmail } from './email-templates';
import { adminClient } from './supabase';

/**
 * Transactional email through Resend. As in VC Writer, the outcome is logged
 * to `email_events` (template names prefixed dit-) and a send
 * failure never fails the purchase: the license already exists and the
 * account page always shows it.
 */

const deliver = async (to: string, userId: string | null, email: RenderedEmail): Promise<{ sent: boolean }> => {
  const log = {
    user_id: userId,
    template: `${email.template}@${email.version}`,
    status: 'queued',
    provider_message_id: null as string | null,
    error: null as string | null,
  };
  try {
    const { data, error } = await new Resend(env.resendApiKey).emails.send({
      from: env.resendFrom,
      to,
      subject: email.subject,
      html: email.html,
      text: email.text,
    });
    if (error) throw new Error(error.message);
    log.status = 'sent';
    log.provider_message_id = data?.id ?? null;
  } catch (cause) {
    log.status = 'failed';
    log.error = cause instanceof Error ? cause.message : String(cause);
  }
  await adminClient().from('email_events').insert(log);
  return { sent: log.status === 'sent' };
};

const links = () => ({ accountUrl: `${env.siteUrl}/account`, downloadUrl: `${env.siteUrl}/download` });

export const sendLicenseEmail = (input: { to: string; userId: string; serial: string; planName: string }) =>
  deliver(input.to, input.userId, licenseIssued({ serial: input.serial, planName: input.planName, ...links() }));

export const sendLicenseReminder = (input: { to: string; userId: string; serial: string; planName: string }) =>
  deliver(input.to, input.userId, licenseReminder({ serial: input.serial, planName: input.planName, ...links() }));
