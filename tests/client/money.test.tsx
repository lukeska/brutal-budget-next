import { Money } from "@client/components/ui/money";
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

describe("Money", () => {
  it("formats minor units with tabular figures", () => {
    render(<Money minor={123456} currency="EUR" />);
    const el = screen.getByText(/1,234\.56|1\.234,56/);
    expect(el).toHaveClass("font-numbers");
    expect(el).not.toHaveClass("text-positive");
    expect(el.textContent).not.toMatch(/^[+−-]/);
  });

  it("shows a plus sign and the positive colour for a signed positive amount", () => {
    render(<Money minor={500} currency="EUR" signed />);
    const el = screen.getByText(/5\.00|5,00/);
    expect(el.textContent?.startsWith("+")).toBe(true);
    expect(el).toHaveClass("text-positive");
  });

  it("shows a minus sign and the negative colour for a signed negative amount", () => {
    render(<Money minor={-500} currency="EUR" signed />);
    const el = screen.getByText(/5\.00|5,00/);
    expect(el.textContent?.startsWith("−")).toBe(true);
    expect(el.textContent).not.toMatch(/-/);
    expect(el).toHaveClass("text-negative");
  });

  it("shows zero without a sign or colour", () => {
    render(<Money minor={0} currency="JPY" signed />);
    const el = screen.getByText(/0/);
    expect(el.textContent).not.toMatch(/[+−]/);
    expect(el).not.toHaveClass("text-positive");
    expect(el).not.toHaveClass("text-negative");
  });

  it("shows a minus sign for an unsigned negative amount without colouring it", () => {
    render(<Money minor={-250} currency="EUR" />);
    const el = screen.getByText(/2\.50|2,50/);
    expect(el.textContent?.startsWith("−")).toBe(true);
    expect(el).not.toHaveClass("text-negative");
  });
});
