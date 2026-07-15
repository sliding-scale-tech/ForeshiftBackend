"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { useSignIn } from "@clerk/nextjs/legacy";
import { isClerkAPIResponseError } from "@clerk/nextjs/errors";

const schema = z.object({
  email: z.string().min(1, "Email is required").email("Enter a valid email address"),
  password: z.string().min(1, "Password is required"),
});

type FormValues = z.infer<typeof schema>;

// Fully custom sign-in — no Google, no sign-up. Admin accounts are provisioned
// by the owner directly in Clerk, so this form only ever needs email+password
// against Clerk's headless useSignIn(), bypassing the hosted <SignIn/> widget
// (which always shows every auth method enabled on the Clerk instance).
export default function SignInPage() {
  const { isLoaded, signIn, setActive } = useSignIn();
  const router = useRouter();
  const [formError, setFormError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const {
    register,
    handleSubmit,
    formState: { errors },
  } = useForm<FormValues>({ resolver: zodResolver(schema) });

  async function onSubmit(values: FormValues) {
    if (!isLoaded) return;
    setFormError(null);
    setSubmitting(true);
    try {
      const result = await signIn.create({
        identifier: values.email,
        password: values.password,
      });

      if (result.status === "complete") {
        await setActive({ session: result.createdSessionId });
        router.push("/");
        return;
      }

      // Any non-complete status (e.g. an unexpected second factor) — this admin
      // flow doesn't build UI for it, so surface a clear message instead of
      // silently hanging.
      setFormError("Additional verification is required for this account.");
    } catch (err) {
      if (isClerkAPIResponseError(err)) {
        // Don't parrot Clerk's specific reason (account-enumeration risk) —
        // wrong email and wrong password should look identical to the user.
        setFormError("Invalid email or password.");
      } else {
        setFormError("Something went wrong. Please try again.");
      }
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="authpage">
      <div className="authbox">
        <div className="brand">
          Fore<span>Shift</span>
        </div>
        <div className="authcard">
          <h1>Admin sign in</h1>
          <p className="sub">Sign in with the credentials provided to you.</p>

          <form onSubmit={handleSubmit(onSubmit)} noValidate>
            <label className="flabel" htmlFor="email">
              Email
            </label>
            <input
              id="email"
              type="email"
              autoComplete="email"
              className="finput"
              {...register("email")}
            />
            {errors.email && <p className="ferr">{errors.email.message}</p>}

            <label className="flabel" htmlFor="password">
              Password
            </label>
            <input
              id="password"
              type="password"
              autoComplete="current-password"
              className="finput"
              {...register("password")}
            />
            {errors.password && <p className="ferr">{errors.password.message}</p>}

            {formError && <p className="ferr formerr">{formError}</p>}

            <button type="submit" className="btn primary fsubmit" disabled={submitting}>
              {submitting ? "Signing in…" : "Sign in"}
            </button>
          </form>
        </div>
      </div>
    </div>
  );
}
