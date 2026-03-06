// main.js
// 使用 Three.js + WebXR 建立 AR 場景，偵測地板並生成環繞使用者的作品圖示環形佈局

// 從本機 libs/ 匯入 three.js ES module 與 OrbitControls
import * as THREE from './libs/three.module.js';
import { OrbitControls } from './libs/OrbitControls.js';
import { projects } from './projects.js';

// GSAP 由 index.html 透過 CDN script 掛在全域變數 window.gsap
const gsap = window.gsap;

let scene;
let camera;
let renderer;
let controls;                    // 只在桌面預覽模式使用的滑鼠軌道控制器

let ring = null;                 // 作品圖示環形群組
let hasPlacedRing = false;       // 是否已經在地板上放置環形
let isARMode = false;            // true = WebXR AR 模式；false = 桌面預覽模式

// WebXR hit-test 相關（僅在 AR 模式會使用）
let hitTestSource = null;
let hitTestSourceRequested = false;
let viewerSpace = null;
let reticle = null;              // 用來顯示偵測到的地板位置（準星）

// Raycaster 互動
const raycaster = new THREE.Raycaster();
const tapPosition = new THREE.Vector2();

// 半徑與圖示尺寸（公尺）
const RING_RADIUS = 1.5;      // AR 模式中的環半徑
const ICON_SIZE = 0.5;        // AR 模式中圖示邊長
const DESKTOP_RADIUS = 2.0;   // 桌面預覽模式的環半徑
const DESKTOP_ICON_SIZE = 0.7; // 桌面預覽模式中圖示邊長

// === 初始化 Three.js 基本場景（但還沒啟動 AR）===
function initThree() {
  scene = new THREE.Scene();

  // 建立透視相機，WebXR 啟動後會由裝置相機接管內部矩陣
  camera = new THREE.PerspectiveCamera(
    70,
    window.innerWidth / window.innerHeight,
    0.01,
    20
  );
  // 桌面預覽模式：把攝影機放在圓環中心附近，讓作品「環繞使用者」
  const DESKTOP_HEIGHT = 1;      // 使用者眼睛高度（y）
  camera.position.set(0, DESKTOP_HEIGHT, 0.01);
  camera.lookAt(0, DESKTOP_HEIGHT, 0);

  renderer = new THREE.WebGLRenderer({
    antialias: true,
    alpha: true
  });
  renderer.setPixelRatio(window.devicePixelRatio || 1);
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.outputEncoding = THREE.sRGBEncoding;
  renderer.xr.enabled = true; // 啟用 WebXR 支援

  renderer.domElement.classList.add('webgl');
  document.body.appendChild(renderer.domElement);

  // 只在桌面預覽模式下使用的滑鼠軌道控制（右鍵旋轉視角，左鍵點擊物件）
  controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.enablePan = false;
  controls.target.set(0, DESKTOP_HEIGHT, 0);

  // 視窗尺寸改變時更新相機與 renderer
  window.addEventListener('resize', onWindowResize, false);

  // 建立地板 reticle（簡單的圓形環狀網格）
  const ringGeo = new THREE.RingGeometry(0.08, 0.1, 32);
  const ringMat = new THREE.MeshBasicMaterial({
    color: 0x00ff88,
    transparent: true,
    opacity: 0.8,
    side: THREE.DoubleSide
  });
  reticle = new THREE.Mesh(ringGeo, ringMat);
  reticle.rotation.x = -Math.PI / 2;
  reticle.matrixAutoUpdate = false;
  reticle.visible = false;
  scene.add(reticle);

  // 點擊 / 觸控事件：用來放置環形或選取作品圖示
  const canvas = renderer.domElement;
  canvas.addEventListener('click', onCanvasTap, false);
  canvas.addEventListener('touchend', onCanvasTap, false);
}

// === 啟動 AR Session 與 hit-test ===
async function startARSession() {
  if (!navigator.xr) {
    alert('此裝置或瀏覽器尚不支援 WebXR AR。請使用最新的 iOS Safari 或 Android Chrome 並啟用 WebXR。');
    return;
  }

  try {
    isARMode = true;

    const session = await navigator.xr.requestSession('immersive-ar', {
      requiredFeatures: ['hit-test', 'local']
    });

    // 將 Session 交給 Three.js 的 WebXRManager
    renderer.xr.setReferenceSpaceType('local');
    await renderer.xr.setSession(session);

    // 使用 setAnimationLoop 作為 WebXR 渲染迴圈入口
    renderer.setAnimationLoop(onXRFrame);

    // 當 Session 結束時清除狀態
    session.addEventListener('end', () => {
      hitTestSourceRequested = false;
      hitTestSource = null;
      viewerSpace = null;
      ring = null;
      hasPlacedRing = false;
      isARMode = false;
      if (reticle) {
        reticle.visible = false;
      }
    });

    // 隱藏 UI overlay（按鈕等）
    const overlay = document.getElementById('ui-overlay');
    if (overlay) overlay.style.display = 'none';

  } catch (err) {
    console.error(err);
    alert('無法啟動 AR Session，請確認瀏覽器與權限設定。');
  }
}

// === 桌面預覽模式：直接在鏡頭前方生成作品環形 ===
function startDesktopDemo() {
  isARMode = false;
  hasPlacedRing = true;

  // 隱藏 UI overlay
  const overlay = document.getElementById('ui-overlay');
  if (overlay) overlay.style.display = 'none';

  // 在桌面模式下，使用固定座標系的 8 個圖示位置
  createDesktopRing();

  // 使用 setAnimationLoop 做一般的動畫迴圈（無 XR Session 也可使用）
  renderer.setAnimationLoop(onDesktopFrame);
}

// === 桌面模式每一幀的更新 ===
function onDesktopFrame(time) {
  if (ring) {
    // 讓 8 個圖示在半徑 DESKTOP_RADIUS 的水平圓環上繞著你轉（全部朝向圓心）
    const t = time * 0.0004; // 時間 → 角度偏移
    const height = 0.75;
    const count = ring.children.length || 1;

    ring.children.forEach((child, index) => {
      const baseAngle = (index / count) * Math.PI * 2;
      const angle = baseAngle + t;
      const x = DESKTOP_RADIUS * Math.cos(angle);
      const z = DESKTOP_RADIUS * Math.sin(angle);
      child.position.set(x, height, z);
      child.lookAt(0, height, 0);
    });
  }
  if (controls) {
    controls.update();
  }
  renderer.render(scene, camera);
}

// === 每一幀的 WebXR 回呼 ===
function onXRFrame(time, frame) {
  const session = renderer.xr.getSession();
  if (!session || !frame) {
    renderer.render(scene, camera);
    return;
  }

  const referenceSpace = renderer.xr.getReferenceSpace();

  // 第一次進入時建立 hit-test source
  if (!hitTestSourceRequested) {
    hitTestSourceRequested = true;

    session.requestReferenceSpace('viewer').then((space) => {
      viewerSpace = space;
      session.requestHitTestSource({ space: viewerSpace }).then((source) => {
        hitTestSource = source;
      });
    }).catch((err) => {
      console.warn('建立 hit-test source 失敗：', err);
    });
  }

  if (hitTestSource) {
    const hitTestResults = frame.getHitTestResults(hitTestSource);
    if (hitTestResults.length > 0) {
      const hit = hitTestResults[0];
      const pose = hit.getPose(referenceSpace);

      // 使用 pose 的 transform 更新 reticle 的 world matrix
      const mat = new THREE.Matrix4();
      mat.fromArray(pose.transform.matrix);
      reticle.visible = true;
      reticle.matrix.fromArray(pose.transform.matrix);
    } else {
      reticle.visible = false;
    }
  }

  // 在 render loop 中讓作品環形緩慢旋轉
  if (ring) {
    ring.rotation.y += 0.001; // 每幀旋轉一點點
  }

  renderer.render(scene, camera);
}

// === 建立作品圖示環形 ===
function createProjectRing(position) {
  if (ring) {
    scene.remove(ring);
  }

  ring = new THREE.Group();
  ring.name = 'project-ring';

  const loader = new THREE.TextureLoader();

  projects.forEach((project, index) => {
    const angle = (index / projects.length) * Math.PI * 2; // 依 index 計算角度
    const x = RING_RADIUS * Math.cos(angle);
    const z = RING_RADIUS * Math.sin(angle);

    // 建立平面幾何作為圖示載體
    const geometry = new THREE.PlaneGeometry(ICON_SIZE, ICON_SIZE);

    const texture = loader.load(
      project.icon,
      undefined,
      undefined,
      (err) => console.warn('載入圖示失敗：', project.icon, err)
    );
    texture.encoding = THREE.sRGBEncoding;
    texture.flipY = false; // 與 WebGL 材質方向對齊

    const material = new THREE.MeshBasicMaterial({
      map: texture,
      transparent: true
    });

    const plane = new THREE.Mesh(geometry, material);
    plane.position.set(x, position.y, z);
    // 讓圖示朝向中心（也就是使用者）
    plane.lookAt(position);

    // 把專案相關資料記在 userData，方便點擊時取得
    plane.userData.projectId = project.id;
    plane.userData.projectTitle = project.title;
    plane.userData.projectPdf = project.pdf;

    // 稍微往後傾斜 45 度，讓圖示有俯視感
    plane.rotateX(-Math.PI / 4);

    ring.add(plane);
  });

  scene.add(ring);
}

// === 桌面模式專用：在固定位置建立 8 個圖示（照你給的座標，環繞使用者）===
function createDesktopRing() {
  if (ring) {
    scene.remove(ring);
  }

  ring = new THREE.Group();
  ring.name = 'project-ring-desktop';

  const loader = new THREE.TextureLoader();

  // 桌面模式：在水平圓環上擺 8 個點，環繞你（Y 是高度）
  const height = 0.75; // icon 高度
  const center = new THREE.Vector3(0, height, 0);
  const count = projects.length;

  projects.forEach((project, index) => {
    const angle = (index / count) * Math.PI * 2;
    const x = DESKTOP_RADIUS * Math.cos(angle);
    const z = DESKTOP_RADIUS * Math.sin(angle);

    // 外框：圓角矩形卡片
    const cardShape = new THREE.Shape();
    const w = DESKTOP_ICON_SIZE * 1.2;
    const h = DESKTOP_ICON_SIZE * 1.2;
    const r = Math.min(w, h) * 0.2;

    cardShape.moveTo(-w / 2 + r, -h / 2);
    cardShape.lineTo(w / 2 - r, -h / 2);
    cardShape.quadraticCurveTo(w / 2, -h / 2, w / 2, -h / 2 + r);
    cardShape.lineTo(w / 2, h / 2 - r);
    cardShape.quadraticCurveTo(w / 2, h / 2, w / 2 - r, h / 2);
    cardShape.lineTo(-w / 2 + r, h / 2);
    cardShape.quadraticCurveTo(-w / 2, h / 2, -w / 2, h / 2 - r);
    cardShape.lineTo(-w / 2, -h / 2 + r);
    cardShape.quadraticCurveTo(-w / 2, -h / 2, -w / 2 + r, -h / 2);

    const cardGeometry = new THREE.ShapeGeometry(cardShape);
    const cardMaterial = new THREE.MeshBasicMaterial({
      color: 0x101820,
      transparent: true,
      opacity: 0.9
    });
    const cardMesh = new THREE.Mesh(cardGeometry, cardMaterial);

    // 內層圖示
    const iconGeometry = new THREE.PlaneGeometry(DESKTOP_ICON_SIZE, DESKTOP_ICON_SIZE);

    const texture = loader.load(
      project.icon,
      undefined,
      undefined,
      (err) => console.warn('載入圖示失敗：', project.icon, err)
    );
    texture.encoding = THREE.sRGBEncoding;
    texture.flipY = false;
    // 讓桌面模式圖示在你視角下轉回正向（再旋轉 180 度抵銷目前的顛倒）
    texture.center.set(0.5, 0.5);
    texture.rotation = Math.PI;

  const iconMaterial = new THREE.MeshBasicMaterial({
    map: texture,
    transparent: true,
    side: THREE.DoubleSide  // 讓圖示在內外兩側都正向可見
  });

  const iconMesh = new THREE.Mesh(iconGeometry, iconMaterial);
  iconMesh.position.set(0, 0, 0.001); // 微微浮在卡片前方，避免 Z-fighting

    // 卡片群組（外框 + 圖示）
    const group = new THREE.Group();
    group.add(cardMesh);
    group.add(iconMesh);

    group.position.set(x, height, z);
    // 桌面模式：卡片面向圓心，你站在圓心內被環繞
    group.lookAt(center);

    group.userData.projectId = project.id;
    group.userData.projectTitle = project.title;
    group.userData.projectPdf = project.pdf;

    ring.add(group);
  });

  scene.add(ring);
}

// === 點擊 / 觸控處理 ===
function onCanvasTap(event) {
  if (event.cancelable) {
    event.preventDefault();
  }

  // AR 模式：若當前還沒放置環形，而 reticle 顯示中 → 將環形放在 reticle 位置
  if (isARMode) {
    if (!hasPlacedRing && reticle && reticle.visible) {
      const reticlePosition = new THREE.Vector3();
      reticle.getWorldPosition(reticlePosition);
      createProjectRing(reticlePosition);
      hasPlacedRing = true;
      return;
    }
  }

  // 已經放置環形 → 當作選取圖示
  if (!ring) return;

  const canvas = renderer.domElement;
  let x, y;

  if (event.changedTouches && event.changedTouches.length > 0) {
    const touch = event.changedTouches[0];
    const rect = canvas.getBoundingClientRect();
    x = ((touch.clientX - rect.left) / rect.width) * 2 - 1;
    y = -((touch.clientY - rect.top) / rect.height) * 2 + 1;
  } else {
    const rect = canvas.getBoundingClientRect();
    x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
    y = -((event.clientY - rect.top) / rect.height) * 2 + 1;
  }

  tapPosition.set(x, y);

  // 建立從相機出發的 ray，與環形中的所有圖示平面做相交測試
  raycaster.setFromCamera(tapPosition, camera);
  const intersects = raycaster.intersectObjects(ring.children, true);

  if (intersects.length > 0) {
    const hit = intersects[0].object;
    const projectId = hit.userData.projectId;
    const projectPdf = hit.userData.projectPdf;

    if (projectId) {
      console.log('點擊作品：', projectId);

      // 使用 GSAP 動畫放大縮小
      gsap.to(hit.scale, {
        x: 1.2,
        y: 1.2,
        z: 1.2,
        duration: 0.2,
        yoyo: true,
        repeat: 1,
        ease: 'power2.out'
      });

      // 桌面預覽模式：順便開啟對應的學習歷程 / 文件 PDF（若有設定路徑）
      if (!isARMode && typeof projectPdf === 'string' && projectPdf.length > 0) {
        window.open(projectPdf, '_blank');
      }
    }
  }
}

// === 視窗大小改變時更新 ===
function onWindowResize() {
  if (!camera || !renderer) return;
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
}

// === 入口：初始化 Three.js，綁定「進入 AR」與「桌面預覽」按鈕 ===
function init() {
  initThree();

  const arButton = document.getElementById('enter-ar-btn');
  const desktopButton = document.getElementById('enter-desktop-btn');

  // 綁定 AR 按鈕（若瀏覽器支援 WebXR）
  if (arButton) {
    if (navigator.xr) {
      arButton.addEventListener('click', () => {
        startARSession();
      });
    } else {
      // 若不支援 AR，就提示並讓按鈕呈現停用狀態
      arButton.textContent = '此瀏覽器不支援 AR';
      arButton.disabled = true;
      arButton.style.opacity = '0.4';
    }
  }

  // 桌面預覽模式：任何支援 WebGL 的瀏覽器都可以用
  if (desktopButton) {
    desktopButton.addEventListener('click', () => {
      startDesktopDemo();
    });
  }
}

init();