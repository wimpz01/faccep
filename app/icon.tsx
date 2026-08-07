import { ImageResponse } from "next/og";

export const size = { width: 32, height: 32 };
export const contentType = "image/png";

export default function Icon() {
  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          background: "#4f46cf",
          color: "#ffffff",
          // Two letters in 32px, so smaller and tighter than the single F was.
          fontSize: 15,
          fontWeight: 700,
          borderRadius: 7,
          letterSpacing: "-0.06em",
        }}
      >
        NR
      </div>
    ),
    size,
  );
}
