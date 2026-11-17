import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { AuthCard } from "@/components/auth/auth-card";

describe("AuthCard", () => {
  it("shows the Le Studio wordmark, not the former Jiroo name", () => {
    const { container } = render(<AuthCard subtitle="Connexion">contenu</AuthCard>);

    expect(container.querySelector(".t-h1")).toHaveTextContent(/^Le Studio$/);
    expect(container).not.toHaveTextContent(/Jiroo/i);
    expect(screen.getByText("Connexion")).toBeInTheDocument();
  });
});
