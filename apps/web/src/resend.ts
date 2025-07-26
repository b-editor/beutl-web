import type { EmailConfig } from "@auth/core/providers/email";

export async function sendEmail(params: {
  to: string;
  subject: string;
  body: string;
}) {
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${options.apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      from: options.from,
      to: params.to,
      subject: params.subject,
      text: params.body,
      html: renderUnsafeEmailTemplate(params.body),
    }),
  });

  if (!res.ok)
    throw new Error(`Resend error: ${JSON.stringify(await res.json())}`);
}

export const options = {
  from: "Beutl <noreply@notifications.beditor.net>",
  apiKey: process.env.AUTH_RESEND_KEY as string,
  sendVerificationRequest: async (
    params: Parameters<EmailConfig["sendVerificationRequest"]>[0],
  ) => {
    const { identifier: to, provider, url } = params;
    const { host } = new URL(url);
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${provider.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from: provider.from,
        to,
        subject: `Sign in to ${host}`,
        text: `Click the link below to sign in:\n${url}`,
        html: renderUnsafeEmailTemplate(`
          <p>Click the link below to sign in:</p>
          <a href="${url}">Sign in</a>
        `),
      }),
    });

    if (!res.ok)
      throw new Error(`Resend error: ${JSON.stringify(await res.json())}`);
  },
};

export function renderUnsafeEmailTemplate(content: string): string {
  return `<!DOCTYPE html PUBLIC "-//W3C//DTD XHTML 1.0 Transitional//EN" "http://www.w3.org/TR/xhtml1/DTD/xhtml1-transitional.dtd">
<html xmlns="http://www.w3.org/1999/xhtml" xmlns="http://www.w3.org/1999/xhtml">

<head>
  <meta name="viewport" content="width=device-width" />
  <meta http-equiv="Content-Type" content="text/html; charset=UTF-8" />
  <title>Beutl</title>
</head>

<body style="
  height: 100%;
  width: 100% !important;
  font-family: -apple-system, BlinkMacSystemFont, 'Noto Sans JP', 'Segoe UI', 'Roboto', 'Oxygen', 'Ubuntu', 'Cantarell', 'Fira Sans', 'Droid Sans', 'Helvetica Neue', sans-serif;
  box-sizing: border-box;
  font-size: 16px;
  line-height: 25px;
  -webkit-font-smoothing: antialiased;
  -webkit-text-size-adjust: none;
  background-color: #ffffff;
  color: #242424;
  ">
  <style type="text/css">
    @media only screen and (max-width: 600px) {
      body {
        padding: 0 16px !important;
      }
    }

    @media only screen and (min-width: 600px) {
      .content-table {
        width: calc(600px - (16px * 2)) !important;
      }
    }

    a {
      text-decoration: none;
      color: #4f52b2;
    }

    a:hover {
      text-decoration: underline;
      color: #444791;
    }

    .logo-url:hover {
      color: #242424;
    }
  </style>
    <table width="100%" cellpadding="0" cellspacing="0">
      <tr>
        <td width="100%" align="center">
          <table cellpadding="0" cellspacing="0" width="100%" class="content-table">
            <tr>
              <td></td>
              <td align="center" valign="top" width="600">
                <table cellpadding="0" cellspacing="0" width="100%">
                  <tr>
                    <td valign="middle" style="padding: 20px 0 10px;">
                      <a href="https://beutl.beditor.net" class="logo-url"
                        style="text-decoration: none !important;">
                        <img src="https://beutl.beditor.net/img/logo.png" width="28" height="28"
                          style="vertical-align: bottom; margin-right: 4px;">
                        <span style="font-size: 20px; font-weight: 600; color: #242424;">Beutl</span>
                      </a>
                    </td>
                  </tr>
                </table>
                <table cellpadding="0" cellspacing="0" align="left"
                  style="margin-top: 16px;margin-bottom: 16px;">
                  <tr>
                    <td valign="top">
                      ${content}
                    </td>
                  </tr>
                </table>
                <table cellpadding="0" cellspacing="0" width="100%" style="
                  background-color: #f5f5f5;
                  margin-top: 16px;
                  padding: 16px;
                  width: 100%;
                  border-radius: 8px;">
                  <tr>
                    <td halign="left" valign="top">
                      <table cellpadding="0" cellspacing="0" style="margin: 0;">
                        <tr>
                          <td style="margin: 0; padding: 0 10px;" valign="top">
                            <a href="https://github.com/b-editor/beutl" target="_blank">
                              <img src="https://beutl.beditor.net/img/github.png"
                                width="24" height="24">
                            </a>
                          </td>
                          <td style="margin: 0; padding: 0 10px;" valign="top">
                            <a href="https://twitter.com/yuto_daisensei" target="_blank">
                              <img src="https://beutl.beditor.net/img/x.png"
                                width="24" height="24">
                            </a>
                          </td>
                          <td style="margin: 0; padding: 0 10px;" valign="top">
                            <a href="https://twitter.com/yuto_daisensei" target="_blank">
                              <img src="https://beutl.beditor.net/img/discord.png"
                                style="margin-top: 2px;" width="24">
                            </a>
                          </td>
                        </tr>
                      </table>
                    </td>
                  </tr>
                  <tr>
                    <td valign="top" style="
                      font-size: 14px;
                      color: #666666;
                      line-height: 25px;
                      margin: 0;
                      padding: 15px 0 0 0;
                      text-align: end;">
                      &copy; 2020-2025 b-editor
                    </td>
                  </tr>
                </table>
              </td>
              <td></td>
            </tr>
          </table>
        </td>
      </tr>
  </table>
</body>

</html>`;
}
