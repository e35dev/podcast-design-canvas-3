(function initializePodcastDesignCanvasModel() {
  const SPEAKER_BUCKETS = [
    { id: "host", label: "Host" },
    { id: "guest1", label: "Guest 1" },
    { id: "guest2", label: "Guest 2" }
  ];

  const PRESETS = [
    {
      id: "conversation-grid",
      name: "Conversation Grid",
      background: "#0b171a",
      accent: "#72ddb6",
      cycleMs: 0
    },
    {
      id: "spotlight-cycle",
      name: "Spotlight Cycle",
      background: "#171321",
      accent: "#f6c85f",
      cycleMs: 4000
    }
  ];

  function getBucketLabel(bucketId) {
    return SPEAKER_BUCKETS.find((bucket) => bucket.id === bucketId)?.label || bucketId;
  }

  function getPresetById(presetId) {
    return PRESETS.find((preset) => preset.id === presetId) || PRESETS[0];
  }

  function validateSetup(setup) {
    const errors = [];
    const assigned = setup.uploads.filter((upload) => upload.file && upload.bucket);
    const buckets = new Set(assigned.map((upload) => upload.bucket));

    if (assigned.length < 2) {
      errors.push("Upload at least two local speaker video files.");
    }

    if (!buckets.has("host")) {
      errors.push("Assign one local video file to Host.");
    }

    if (!buckets.has("guest1") && !buckets.has("guest2")) {
      errors.push("Assign at least one local video file to a Guest bucket.");
    }

    if (assigned.length !== buckets.size) {
      errors.push("Each speaker bucket can only have one video file.");
    }

    if (!PRESETS.some((preset) => preset.id === setup.presetId)) {
      errors.push("Choose a preset layout.");
    }

    return errors;
  }

  function getEpisodeDuration(entries) {
    const durations = entries
      .map((entry) => Number(entry.duration))
      .filter((duration) => Number.isFinite(duration) && duration > 0);
    return durations.length ? Math.max(...durations) : 1;
  }

  function getFrames(presetId, bucketIds, width, height, elapsedMs) {
    const order = SPEAKER_BUCKETS.map((bucket) => bucket.id).filter((bucket) => bucketIds.includes(bucket));
    const inset = 28;
    const gap = 18;

    if (presetId === "spotlight-cycle" && order.length) {
      const preset = getPresetById(presetId);
      const index = Math.floor(elapsedMs / (preset.cycleMs || 4000)) % order.length;
      const mainBucket = order[index];
      const frames = [
        {
          bucket: mainBucket,
          x: inset,
          y: inset,
          width: width - inset * 2,
          height: height - inset * 2,
          spotlight: true
        }
      ];
      order.filter((bucket) => bucket !== mainBucket).forEach((bucket, thumbIndex) => {
        frames.push({
          bucket,
          x: width - 274,
          y: inset + thumbIndex * 150,
          width: 220,
          height: 124,
          spotlight: false
        });
      });
      return frames;
    }

    const hostIncluded = order.includes("host");
    const guests = order.filter((bucket) => bucket !== "host");
    const frames = [];

    if (hostIncluded) {
      frames.push({
        bucket: "host",
        x: inset,
        y: inset,
        width: width * 0.62 - inset,
        height: height - inset * 2,
        spotlight: true
      });
    }

    const stackBuckets = hostIncluded ? guests : order;
    if (!stackBuckets.length) {
      return frames;
    }

    const stackX = hostIncluded ? width * 0.62 + gap : inset;
    const stackWidth = hostIncluded ? width * 0.38 - inset - gap : width - inset * 2;
    const stackHeight = (height - inset * 2 - gap * (stackBuckets.length - 1)) / stackBuckets.length;
    stackBuckets.forEach((bucket, index) => {
      frames.push({
        bucket,
        x: stackX,
        y: inset + index * (stackHeight + gap),
        width: stackWidth,
        height: stackHeight,
        spotlight: false
      });
    });

    return frames;
  }

  function buildExportFilename(title, presetId) {
    const safeTitle = (title || "podcast-episode")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "");
    return `${safeTitle || "podcast-episode"}-${presetId}.webm`;
  }

  window.PodcastDesignCanvasModel = {
    PRESETS,
    SPEAKER_BUCKETS,
    buildExportFilename,
    getBucketLabel,
    getEpisodeDuration,
    getFrames,
    getPresetById,
    validateSetup
  };
}());
