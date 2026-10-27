import nodemailer from "nodemailer";

export type MailMessage = { to: string; subject: string; html?: string; text?: string };
export type MailerConfig = { smtpUrl?: string; postmarkToken?: string; from: string };

export type Mailer = { send(message: MailMessage): Promise<{ id: string | null }> };

/** SMTP (Mailpit locally) or Postmark. With neither configured the message is logged, not sent. */
export function createMailer(cfg: MailerConfig, log: { info: (o: object, m: string) => void }): Mailer {
  const smtp = cfg.smtpUrl ? nodemailer.createTransport(cfg.smtpUrl) : null;
  return {
    async send(message) {
      if (cfg.postmarkToken) {
        const response = await fetch("https://api.postmarkapp.com/email", {
          method: "POST",
          headers: { Accept: "application/json", "Content-Type": "application/json", "X-Postmark-Server-Token": cfg.postmarkToken },
          body: JSON.stringify({
            From: cfg.from,
            To: message.to,
            Subject: message.subject,
            HtmlBody: message.html,
            TextBody: message.text,
            MessageStream: "outbound",
          }),
        });
        if (!response.ok) throw new Error(`Postmark ${response.status}: ${await response.text()}`);
        const body = (await response.json()) as { MessageID?: string };
        return { id: body.MessageID ?? null };
      }
      if (smtp) {
        const info = await smtp.sendMail({ from: cfg.from, ...message });
        return { id: info.messageId ?? null };
      }
      log.info(
        { to: message.to, subject: message.subject, ...(process.env.APP_ENV === "prod" ? {} : { text: message.text }) },
        "mail not configured; message not sent",
      );
      return { id: null };
    },
  };
}
