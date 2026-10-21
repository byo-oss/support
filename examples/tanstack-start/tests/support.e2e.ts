import { test } from "@e2e-dev/web";
import { expect } from "e2e";
import { AGENT, CUSTOMER } from "../src/lib/constants.ts";

test(
  "a customer opens a ticket, an agent replies, the customer solves it",
  { timeout: 120_000 },
  async ({ app, screen }) => {
    const subject = `Cannot export my data ${Date.now()}`;
    const question = "The export button does nothing when I click it.";
    const answer = "Thanks, we reproduced it and shipped a fix. Try again now.";

    // customer: sign in and open a ticket from the widget
    await app.open("/");
    await screen.getByLabel("Email").fill(CUSTOMER.email);
    await screen.getByLabel("Password").fill(CUSTOMER.password);
    await screen.getByRole("button", "Sign in").tap();
    await expect(screen.getByTestId("whoami")).toHaveText(CUSTOMER.email);

    await screen.getByRole("link", "Help").tap();
    await screen.getByRole("button", "Support").tap();
    await screen.getByRole("button", "New ticket").tap();
    await screen.getByLabel("Subject").fill(subject);
    await screen.getByLabel("Message").fill(question);
    await screen.getByRole("button", "Submit ticket").tap();
    // the thread opens with the first message
    await expect(screen.getByText(question)).toBeVisible();

    // agent: sign in, find the ticket in the inbox, reply
    await screen.getByRole("button", "Sign out").tap();
    await screen.getByLabel("Email").fill(AGENT.email);
    await screen.getByLabel("Password").fill(AGENT.password);
    await screen.getByRole("button", "Sign in").tap();
    await expect(screen.getByTestId("whoami")).toHaveText(AGENT.email);

    await screen.getByRole("link", "Inbox").tap();
    await screen.getByText(subject).tap();
    await expect(screen.getByText(question)).toBeVisible();
    await screen.getByLabel("Write a message").fill(answer);
    await screen.getByRole("button", "Send").tap();
    await expect(screen.getByText(answer)).toBeVisible();

    // the sweep mails the reply (the example's mailer is in memory)
    const sweep = await fetch(new URL("/api/cron/support", app.baseUrl));
    expect(sweep.status).toBe(200);
    const { results } = (await sweep.json()) as {
      results: { pluginId: string; last?: { sent?: number } }[];
    };
    expect(results.find((r) => r.pluginId === "support")?.last?.sent).toBe(1);

    // customer: sees the reply, marks the ticket solved
    await screen.getByRole("button", "Sign out").tap();
    await screen.getByLabel("Email").fill(CUSTOMER.email);
    await screen.getByLabel("Password").fill(CUSTOMER.password);
    await screen.getByRole("button", "Sign in").tap();
    await expect(screen.getByTestId("whoami")).toHaveText(CUSTOMER.email);

    await screen.getByRole("link", "Help").tap();
    await screen.getByRole("button", "Support").tap();
    // the widget row reads "#1 <subject>", so match on the subject inside it
    await screen.getByRole("button", new RegExp(subject)).tap();
    await expect(screen.getByText(answer)).toBeVisible();
    await screen.getByRole("button", "Mark solved").tap();
    await expect(screen.getByRole("button", "Reopen")).toBeVisible();
  },
);
