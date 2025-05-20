import { initViewer, loadModel } from "./viewer.js";

initViewer(document.getElementById("preview")).then((viewer) => {
  window._viewerInstance = viewer;

  const urn = window.location.hash?.substring(1);
  setupModelSelection(viewer, urn);
  setupModelUpload(viewer);
  setupColorChange(viewer);
});

function getRandomItems(arr, min = 1, max = arr.length) {
  // Shuffle the array
  let shuffled = arr.slice().sort(() => 0.5 - Math.random());
  // Pick a random count
  let count = Math.floor(Math.random() * (max - min + 1)) + min;
  // Return the first `count` items
  return shuffled.slice(0, count);
}

async function setupModelSelection(viewer, selectedUrn) {
  const dropdown = document.getElementById("models");
  dropdown.innerHTML = "";
  try {
    const resp = await fetch("/api/models");
    if (!resp.ok) {
      throw new Error(await resp.text());
    }
    const models = await resp.json();
    dropdown.innerHTML = models
      .map(
        (model) =>
          `<option value=${model.urn} ${
            model.urn === selectedUrn ? "selected" : ""
          }>${model.name}</option>`
      )
      .join("\n");
    dropdown.onchange = () => onModelSelected(viewer, dropdown.value);
    if (dropdown.value) {
      onModelSelected(viewer, dropdown.value);
    }
  } catch (err) {
    alert("Could not list models. See the console for more details.");
    console.error(err);
  }
}

async function setupColorChange(viewer) {
  const change_color = document.getElementById("change_color");

  let marks = [];
  try {
    const resp = await fetch("scaffolding_marks.json");
    if (!resp.ok) throw new Error("Failed to load scaffolding_marks.json");
    marks = await resp.json();
    // console.log(marks["Mark"]);
  } catch (err) {
    console.error("Error loading scaffolding marks:", err);
  }

  let colorInterval = null;
  let running = false;

  change_color.onclick = async () => {
    if (running) {
      // Stop the loop
      running = false;
      clearInterval(colorInterval);
      colorInterval = null;
      change_color.textContent = "Resume Simulation";
      return;
    }
    running = true;
    change_color.textContent = "Pause Simulation";

    const runColorChange = async () => {
      viewer.clearThemingColors();
      // Recursively collect all dbIds in the model
      const model = viewer.getFirstModel();
      function collectDbIds(node, out) {
        if (typeof node.dbId === "number") out.push(node.dbId);
        if (node.children && node.children.length) {
          node.children.forEach((child) => collectDbIds(child, out));
        }
      }
      const allDbIds = await new Promise((resolve) =>
        model.getObjectTree((tree) => {
          const out = [];
          collectDbIds(tree, out);
          resolve(out);
        })
      );

      let random_marks = getRandomItems(marks["Mark"], 0, 10);
      let random_tilts = generateRandomData(marks["Mark"]);
      viewer.search(
        '"Noise"',
        function (dbIds) {
          viewer.getFirstModel().getBulkProperties(
            dbIds,
            ["Mark"],
            function (elements) {
              const selectedDbIds = [];
              elements.forEach((element) => {
                const markValue = parseInt(element.properties[0].displayValue);
                // Find the corresponding tilt value for this mark
                const tiltObj = random_tilts.find((t) => t.id === markValue);
                if (tiltObj) {
                  const tilt = tiltObj.tilt;
                  let color = null;
                  if (tilt > 10) {
                    color = new THREE.Vector4(1, 0, 0, 1); // Red
                  } else if (tilt > 3) {
                    color = new THREE.Vector4(1, 0.5, 0, 1); // Orange
                  } else if (tilt > 1) {
                    color = new THREE.Vector4(1, 1, 0, 1); // Yellow
                  }
                  if (color) {
                    selectedDbIds.push(element.dbId);
                    viewer.show(element.dbId);
                    viewer.impl.invalidate(true, true, true);
                    viewer.setThemingColor(element.dbId, color);
                  }
                }
              });
              // Hide unselected elements in the search result
              const unselectedDbIds = dbIds.filter(
                (id) => !selectedDbIds.includes(id)
              );
              viewer.hide(unselectedDbIds);
              viewer.impl.invalidate(true, true, true);
            },
            function (error) {
              console.error(error);
            }
          );
        },
        function (error) {
          console.error(error);
        },
        ["Type Name"]
      );
    };

    // Run immediately, then every 10 seconds
    await runColorChange();
    colorInterval = setInterval(async () => {
      if (!running) return;
      await runColorChange();
    }, 10000);
  };
}
async function setupModelUpload(viewer) {
  const upload = document.getElementById("upload");
  const input = document.getElementById("input");
  const models = document.getElementById("models");
  upload.onclick = () => input.click();
  input.onchange = async () => {
    const file = input.files[0];
    let data = new FormData();
    data.append("model-file", file);
    if (file.name.endsWith(".zip")) {
      // When uploading a zip file, ask for the main design file in the archive
      const entrypoint = window.prompt(
        "Please enter the filename of the main design inside the archive."
      );
      data.append("model-zip-entrypoint", entrypoint);
    }
    upload.setAttribute("disabled", "true");
    models.setAttribute("disabled", "true");
    showNotification(
      `Uploading model <em>${file.name}</em>. Do not reload the page.`
    );
    try {
      const resp = await fetch("/api/models", { method: "POST", body: data });
      if (!resp.ok) {
        throw new Error(await resp.text());
      }
      const model = await resp.json();
      setupModelSelection(viewer, model.urn);
    } catch (err) {
      alert(
        `Could not upload model ${file.name}. See the console for more details.`
      );
      console.error(err);
    } finally {
      clearNotification();
      upload.removeAttribute("disabled");
      models.removeAttribute("disabled");
      input.value = "";
    }
  };
}

async function onModelSelected(viewer, urn) {
  if (window.onModelSelectedTimeout) {
    clearTimeout(window.onModelSelectedTimeout);
    delete window.onModelSelectedTimeout;
  }
  window.location.hash = urn;
  try {
    const resp = await fetch(`/api/models/${urn}/status`);
    if (!resp.ok) {
      throw new Error(await resp.text());
    }
    const status = await resp.json();
    switch (status.status) {
      case "n/a":
        showNotification(`Model has not been translated.`);
        break;
      case "inprogress":
        showNotification(`Model is being translated (${status.progress})...`);
        window.onModelSelectedTimeout = setTimeout(
          onModelSelected,
          5000,
          viewer,
          urn
        );
        break;
      case "failed":
        showNotification(
          `Translation failed. <ul>${status.messages
            .map((msg) => `<li>${JSON.stringify(msg)}</li>`)
            .join("")}</ul>`
        );
        break;
      default:
        clearNotification();
        await loadModel(viewer, urn);
        // Show the Start Simulation button after model is loaded
        document.getElementById("change_color").style.display = "inline-block";
        break;
    }
  } catch (err) {
    alert("Could not load model. See the console for more details.");
    console.error(err);
  }
}

function showNotification(message) {
  const overlay = document.getElementById("overlay");
  overlay.innerHTML = `<div class="notification">${message}</div>`;
  overlay.style.display = "flex";
}

function clearNotification() {
  const overlay = document.getElementById("overlay");
  overlay.innerHTML = "";
  overlay.style.display = "none";
}

let tiltLogs = [];
let selectedMarkId = null; // Track selected mark id

function renderTiltLog() {
  const tbody = document.querySelector("#simulation-log-table tbody");
  tbody.innerHTML = tiltLogs
    .map((log, idx) => {
      return log.data
        .filter((item) => item.tilt > 1) // Only show yellow, orange, red
        .map((item, i) => {
          // Determine importance by tilt value
          let color = null;
          if (item.tilt > 10) {
            color = "#e53935"; // Red
          } else if (item.tilt > 3) {
            color = "#fb8c00"; // Orange
          } else if (item.tilt > 1) {
            color = "#fdd835"; // Yellow
          }
          // Add 'selected' class if this row is selected
          const selectedClass = selectedMarkId === item.id ? 'selected' : '';
          return `
            <tr tabindex="0" class="${selectedClass}" onclick="zoomToElement(${item.id})">
              <td class="importance"><span class='importance-dot' style='background:${color}'></span></td>
              <td class="tilt">${item.tilt.toFixed(2)}</td>
              <td class="itemid">${item.id}</td>
              <td class="time">${new Date(log.timestamp).toLocaleTimeString()}</td>
            </tr>
          `;
        })
        .join("");
    })
    .join("");
}

// Add global zoomToElement function
window.zoomToElement = function (mark) {
  // If already selected, unselect and show whole model
  if (selectedMarkId === mark) {
    selectedMarkId = null;
    renderTiltLog();
    if (window._viewerInstance) {
      const viewer = window._viewerInstance;
      const model = viewer.getFirstModel();
      if (model) {
        // viewer.clearThemingColors();
        // viewer.showAll();
        viewer.fitToView(undefined, model);
      }
    }
    return;
  }
  selectedMarkId = mark;
  renderTiltLog();
  console.log(`Zooming to element with mark: ${mark}`);
  if (window._viewerInstance) {
    const viewer = window._viewerInstance;
    const model = viewer.getFirstModel();
    if (model) {
      viewer.search(
        "" + mark,
        function (dbIds) {
          if (dbIds.length > 0) {
            const dbId = dbIds[0];
            viewer.fitToView([dbId], model);
          } else {
            console.warn(`No element found with mark: ${mark}`);
          }
        },
        function (error) {
          console.error(`Error searching for mark: ${mark}`, error);
        },
        ["Mark"]
      );
    }
  } else {
    console.warn("Viewer instance not ready");
  }
};

// Patch generateRandomData to also update the log table
function generateRandomData(array) {
  const timestamp = new Date().toISOString();
  const result = array.map((id) => {
    let values = [];
    // Always generate a value from 0 to 1
    values.push(Math.random());
    // 0.625% chance for 1 to 3
    if (Math.random() < 0.00625) {
      values.push(1 + Math.random() * 2);
    }
    // 0.3125% chance for 3 to 10
    if (Math.random() < 0.003125) {
      values.push(3 + Math.random() * 7);
    }
    // 0.0625% chance for 10 to 20
    if (Math.random() < 0.000625) {
      values.push(10 + Math.random() * 10);
    }
    // The largest number is the final number
    const maxValue = Math.max(...values);
    return { id: id, tilt: maxValue };
  });
  tiltLogs.push({ timestamp, data: result });
  renderTiltLog(); // update the drawer
  // Optionally trigger color change if needed
  // If you want to trigger color change here, you can call a callback or event
  // But since the color change logic is in setupColorChange, just keep the return
  return result;
}
