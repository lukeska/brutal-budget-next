import { OfflineBanner } from "@client/components/OfflineBanner";
import { markOffline, resetOnlineForTests, useOnline } from "@client/lib/online";
import { act, render, renderHook, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

beforeEach(() => {
  vi.useFakeTimers();
  resetOnlineForTests();
});

afterEach(() => {
  resetOnlineForTests();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("connection recovery", () => {
  it("probes the server with backoff after a network failure and comes back online when it answers", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockRejectedValueOnce(new TypeError("Failed to fetch"))
      .mockResolvedValueOnce(new Response("{}", { status: 200 }));
    const online = renderHook(() => useOnline());
    act(() => markOffline());
    expect(online.result.current).toBe(false);

    // First probe after 2s fails; the next waits 4s more.
    await act(() => vi.advanceTimersByTimeAsync(2000));
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(fetchSpy.mock.calls[0]?.[0]).toBe("/api/health");
    expect(online.result.current).toBe(false);
    await act(() => vi.advanceTimersByTimeAsync(3999));
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    await act(() => vi.advanceTimersByTimeAsync(1));
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    expect(online.result.current).toBe(true);

    // Back online: probing stops.
    await act(() => vi.advanceTimersByTimeAsync(60_000));
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it("stops probing when nothing is listening", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockRejectedValue(new TypeError("Failed to fetch"));
    const online = renderHook(() => useOnline());
    act(() => markOffline());
    online.unmount();
    await act(() => vi.advanceTimersByTimeAsync(60_000));
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("lets the partner try again from the offline banner", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("{}", { status: 200 }));
    render(<OfflineBanner />);
    act(() => markOffline());
    const button = screen.getByRole("button", { name: "Try again" });
    await act(async () => {
      button.click();
    });
    expect(fetchSpy).toHaveBeenCalledWith("/api/health", expect.anything());
    expect(screen.queryByRole("status")).toBeNull();
  });
});
