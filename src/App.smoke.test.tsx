import "@testing-library/jest-dom/vitest";
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import App from "./App";

describe("proxbot shell", () => {
  it("renders the observability workspace", () => {
    render(<App />);
    expect(screen.getByRole("main", { name: "proxbot" })).toBeVisible();
  });
});
