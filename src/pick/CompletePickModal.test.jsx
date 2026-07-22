// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import CompletePickModal from "./CompletePickModal";

const detail = {
  lines: [{ lineId: "1", sku: "GLV-1", description: "Test Glove", qtyRemaining: 2, itemId: "555" }],
  destinationLocationId: "3",
  destinationLocationName: "Store",
};
const pickedByLine = { 1: 2 };

const BIN_PLACEHOLDER = "Scan or type bin number…";
const CONFIRM_TEXT = /Confirm — create fulfillment/;

const fetchMock = vi.fn();
vi.stubGlobal("fetch", fetchMock);

function renderModal(onConfirm = vi.fn()) {
  render(
    <CompletePickModal
      detail={detail}
      pickedByLine={pickedByLine}
      busy={false}
      error={null}
      onConfirm={onConfirm}
      onCancel={() => {}}
    />
  );
  return { input: screen.getByPlaceholderText(BIN_PLACEHOLDER), onConfirm };
}

const enterBin = (input, value) => {
  fireEvent.change(input, { target: { value } });
  fireEvent.keyDown(input, { key: "Enter" });
};

afterEach(() => { cleanup(); fetchMock.mockReset(); });

describe("CompletePickModal destination bin", () => {
  it("disables Confirm until a bin validates, even with items picked", () => {
    renderModal();
    expect(screen.getByText(CONFIRM_TEXT).disabled).toBe(true);
  });

  it("validates on Enter, shows canonical bin, enables Confirm, passes bin to onConfirm", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({ valid: true, binId: "42", binNumber: "F-01-0002" }),
    });
    const { input, onConfirm } = renderModal();
    enterBin(input, "f-01-0002");

    // Match the ✓ status line specifically — the canonical bin number also
    // appears in the modal subtitle once validated.
    await screen.findByText(/✓ F-01-0002/);
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/bins/validate?locationId=3&binNumber=f-01-0002"
    );
    const confirm = screen.getByText(CONFIRM_TEXT);
    expect(confirm.disabled).toBe(false);
    fireEvent.click(confirm);
    expect(onConfirm).toHaveBeenCalledWith({ binId: "42", binNumber: "F-01-0002" });
  });

  it("shows a not-found message and keeps Confirm disabled on invalid bin", async () => {
    fetchMock.mockResolvedValue({ ok: true, json: async () => ({ valid: false }) });
    const { input } = renderModal();
    enterBin(input, "X-99");

    await screen.findByText('Bin "X-99" not found at Store');
    expect(screen.getByText(CONFIRM_TEXT).disabled).toBe(true);
  });

  it("editing the field after a successful validation resets to unvalidated", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({ valid: true, binId: "42", binNumber: "F-01-0002" }),
    });
    const { input } = renderModal();
    enterBin(input, "F-01-0002");
    await screen.findByText(/✓/);

    fireEvent.change(input, { target: { value: "F-01-0003" } });
    expect(screen.getByText(CONFIRM_TEXT).disabled).toBe(true);
    // Scoped to the bin checkmark text, not a bare /✓/: the picked-line
    // StateChip also renders "✓ Full" for this fixture (qtyRemaining 2,
    // picked 2), which would otherwise false-match.
    expect(screen.queryByText(/✓ F-01-0002/)).toBeNull();
  });

  it("shows an error message when the validate endpoint fails", async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 500, json: async () => ({ error: "SuiteQL down" }) });
    const { input } = renderModal();
    enterBin(input, "B-1");

    await screen.findByText(/SuiteQL down/);
    expect(screen.getByText(CONFIRM_TEXT).disabled).toBe(true);
  });
});
