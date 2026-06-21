// Accès à la caméra arrière, utilisée comme simple viseur.

export async function startCamera(videoEl) {
  if (!navigator.mediaDevices?.getUserMedia) {
    throw new Error("Caméra indisponible (getUserMedia)");
  }
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: false,
    video: {
      facingMode: { ideal: 'environment' },
      width: { ideal: 1920 },
      height: { ideal: 1080 },
    },
  });
  videoEl.srcObject = stream;
  await videoEl.play();

  const track = stream.getVideoTracks()[0];
  try {
    const caps = track.getCapabilities?.() ?? {};
    const advanced = [];
    if (caps.zoom) advanced.push({ zoom: caps.zoom.min ?? 1 });
    if (caps.focusMode?.includes('manual') && caps.focusDistance) {
      advanced.push({ focusMode: 'manual', focusDistance: caps.focusDistance.max });
    } else if (caps.focusMode?.includes('continuous')) {
      advanced.push({ focusMode: 'continuous' });
    }
    if (advanced.length) await track.applyConstraints({ advanced });
  } catch { /* capacités non supportées : on ignore */ }

  return stream;
}

export function stopCamera(stream) {
  stream?.getTracks().forEach((t) => t.stop());
}
