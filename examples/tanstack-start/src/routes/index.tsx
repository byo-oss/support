import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { authClient } from "../lib/auth-client";
import { AGENT, CUSTOMER } from "../lib/constants";

export const Route = createFileRoute("/")({ component: Home });

function Home() {
  const { data: session, isPending } = authClient.useSession();
  if (isPending) return null;
  return session ? (
    <p>
      Signed in as {session.user.email}. Open <strong>Help</strong> as a customer or{" "}
      <strong>Inbox</strong> as an agent.
    </p>
  ) : (
    <SignIn />
  );
}

function SignIn() {
  const navigate = useNavigate();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);

  return (
    <form
      onSubmit={async (event) => {
        event.preventDefault();
        const { error } = await authClient.signIn.email({ email, password });
        setError(error?.message ?? null);
        if (!error) await navigate({ to: "/" });
      }}
      style={{ display: "grid", gap: 8, maxWidth: 320 }}
    >
      <h1>Sign in</h1>
      <p style={{ margin: 0, fontSize: 14 }}>
        Customer: {CUSTOMER.email} / {CUSTOMER.password}
        <br />
        Agent: {AGENT.email} / {AGENT.password}
      </p>
      <label>
        Email
        <input
          type="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          required
        />
      </label>
      <label>
        Password
        <input
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          required
        />
      </label>
      <button type="submit">Sign in</button>
      {error ? <p role="alert">{error}</p> : null}
    </form>
  );
}
