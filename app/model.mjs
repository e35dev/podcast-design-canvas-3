export const SPEAKER_BUCKETS = [
  { id: "host", label: "Host" },
  { id: "guest1", label: "Guest 1" },
  { id: "guest2", label: "Guest 2" }
];

export const PRESETS = [
  {
    id: "conversation-grid",
    name: "Conversation Grid",
    description: "Host anchor on the left with both guests stacked on the right.",
    pacing: "Steady",
    background: "#07111f",
    accent: "#38bdf8"
  },
  {
    id: "spotlight-cycle",
    name: "Spotlight Cycle",
    description: "Rotating spotlight that shifts focus across the assigned speakers.",
    pacing: "Rotate every 8 seconds",
    background: "#111827",
    accent: "#f59e0b",
    cycleMs: 8000
  }
];

export function getBucketLabel(bucketId) {
  return SPEAKER_BUCKETS.find((bucket) => bucket.id === bucketId)?.label || bucketId;
}

export function buildAssignmentMap(uploads) {
  return uploads.reduce((map, upload) => {
    if (upload.bucket) {
      map[upload.bucket] = upload;
    }
    return map;
  }, {});
}

export function validateSetup({ uploads, socials, presetId }) {
  const errors = [];
  const assigned = uploads.filter((upload) => upload.bucket);
  const assignedBuckets = new Set(assigned.map((upload) => upload.bucket));

  if (uploads.length > 3) {
    errors.push("Upload no more than three speaker video files for Host, Guest 1, and Guest 2.");
  }

  if (uploads.length < 2) {
    errors.push("Upload at least two speaker video files.");
  }

  if (uploads.some((upload) => !upload.bucket)) {
    errors.push("Assign every uploaded file to a speaker bucket.");
  }

  if (assigned.length < 2) {
    errors.push("Assign at least two uploaded files to speaker buckets.");
  }

  if (!assignedBuckets.has("host")) {
    errors.push("Assign one uploaded file to the Host bucket.");
  }

  if (assigned.length !== assignedBuckets.size) {
    errors.push("Each speaker bucket can only have one uploaded file.");
  }

  const hasGuest = assignedBuckets.has("guest1") || assignedBuckets.has("guest2");
  if (!hasGuest) {
    errors.push("Assign at least one guest bucket.");
  }

  if (!PRESETS.some((preset) => preset.id === presetId)) {
    errors.push("Choose a preset layout before previewing.");
  }

  for (const bucket of assignedBuckets) {
    const social = socials[bucket];
    if (!social || !social.trim()) {
      errors.push(`Add a social link for ${getBucketLabel(bucket)}.`);
      continue;
    }

    if (!looksLikeUrl(social)) {
      errors.push(`${getBucketLabel(bucket)} needs a valid social URL.`);
    }
  }

  return errors;
}

export function looksLikeUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

export function getPresetById(presetId) {
  return PRESETS.find((preset) => preset.id === presetId) || PRESETS[0];
}

export function getEpisodeDuration(mediaEntries) {
  const durations = mediaEntries
    .map((entry) => Number(entry.duration))
    .filter((duration) => Number.isFinite(duration) && duration > 0);

  return durations.length ? Math.max(...durations) : 1;
}

export function getSpotlightIndex(order, elapsedMs, cycleMs) {
  if (!order.length) {
    return 0;
  }
  return Math.floor(elapsedMs / cycleMs) % order.length;
}

export function getFrames(presetId, assignedBuckets, width, height, elapsedMs = 0) {
  const order = SPEAKER_BUCKETS.map((bucket) => bucket.id).filter((bucket) => assignedBuckets.includes(bucket));
  const insetGap = 18;
  const stagePadding = 28;

  if (presetId === "spotlight-cycle") {
    const preset = getPresetById(presetId);
    const spotlightBucket = order[getSpotlightIndex(order, elapsedMs, preset.cycleMs || 8000)];
    const thumbnails = order.filter((bucket) => bucket !== spotlightBucket);
    const frames = [
      {
        bucket: spotlightBucket,
        x: stagePadding,
        y: stagePadding,
        width: width - stagePadding * 2,
        height: height - stagePadding * 2,
        spotlight: true
      }
    ];

    thumbnails.forEach((bucket, index) => {
      frames.push({
        bucket,
        x: width - 274,
        y: stagePadding + index * 152,
        width: 220,
        height: 124,
        spotlight: false
      });
    });

    return frames;
  }

  const frames = [];
  const hostIncluded = order.includes("host");
  const guests = order.filter((bucket) => bucket !== "host");

  if (hostIncluded) {
    frames.push({
      bucket: "host",
      x: stagePadding,
      y: stagePadding,
      width: width * 0.62 - stagePadding,
      height: height - stagePadding * 2,
      spotlight: true
    });
  }

  if (!guests.length && hostIncluded) {
    return frames;
  }

  if (!hostIncluded && order.length === 2) {
    return order.map((bucket, index) => ({
      bucket,
      x: stagePadding + index * (width / 2),
      y: stagePadding,
      width: width / 2 - stagePadding * 1.5,
      height: height - stagePadding * 2,
      spotlight: false
    }));
  }

  const stackBuckets = hostIncluded ? guests : order;
  const stackX = hostIncluded ? width * 0.62 + insetGap : stagePadding;
  const stackWidth = hostIncluded ? width * 0.38 - stagePadding - insetGap : width - stagePadding * 2;
  const slotHeight = (height - stagePadding * 2 - insetGap * (stackBuckets.length - 1)) / stackBuckets.length;

  stackBuckets.forEach((bucket, index) => {
    frames.push({
      bucket,
      x: stackX,
      y: stagePadding + index * (slotHeight + insetGap),
      width: stackWidth,
      height: slotHeight,
      spotlight: false
    });
  });

  return frames;
}

export function formatSocialLabel(value) {
  if (!value) {
    return "";
  }

  try {
    const url = new URL(value);
    const trimmedPath = url.pathname.replace(/\/$/, "");
    const handle = trimmedPath.split("/").filter(Boolean).pop();
    if (handle) {
      return `@${handle}`;
    }
    return url.hostname.replace(/^www\./, "");
  } catch {
    return value.replace(/^https?:\/\//, "");
  }
}

export function buildExportFilename(title, presetId) {
  const safeTitle = (title || "podcast-episode")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");

  return `${safeTitle || "podcast-episode"}-${presetId}.webm`;
}
