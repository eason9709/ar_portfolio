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
const lastViewerPosition = new THREE.Vector3();  // 每幀更新，供環形跟隨手機

// Raycaster 互動
const raycaster = new THREE.Raycaster();
const tapPosition = new THREE.Vector2();

// 半徑與圖示尺寸（公尺）
const RING_RADIUS = 1.5;      // AR 模式中的環半徑
const ICON_SIZE = 0.5;        // AR 模式中圖示邊長
const AR_RING_HEIGHT = 1.0;   // AR 模式：圖示環的高度（提高到眼睛高度附近）
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
    alert('此裝置或瀏覽器尚不支援 WebXR AR。請使用最新版 Android Chrome 並啟用 WebXR。');
    return;
  }

  try {
    isARMode = true;

    console.log('[AR] 準備 requestSession immersive-ar');
    const session = await navigator.xr.requestSession('immersive-ar', {
      // 多數支援 ARCore 的 Android Chrome 都支援 local-floor + hit-test
      requiredFeatures: ['hit-test', 'local-floor'],
      optionalFeatures: ['dom-overlay'],
      domOverlay: { root: document.body }
    });
    console.log('[AR] requestSession 成功，session=', session);

    // 將 Session 交給 Three.js 的 WebXRManager
    renderer.xr.setReferenceSpaceType('local-floor');
    await renderer.xr.setSession(session);
    console.log('[AR] renderer.xr.setSession 完成');

    // WebXR 輸入：在 AR 模式下使用 XR session 的 select 事件，而不是依賴 DOM click
    const onXRSelect = () => {
      if (!isARMode) return;

      // 第一次 select：以手機為中心放置環形，之後每幀會跟隨手機 (X,Z)
      if (!hasPlacedRing) {
        const center = new THREE.Vector3(lastViewerPosition.x, AR_RING_HEIGHT, lastViewerPosition.z);
        createProjectRing(center);
        hasPlacedRing = true;
        return;
      }

      // 已放置環形之後的 select：用畫面中心的 ray 嘗試選取圖示
      if (!ring) return;
      const xrCamera = renderer.xr.getCamera(camera);
      tapPosition.set(0, 0); // 螢幕中心
      raycaster.setFromCamera(tapPosition, xrCamera);
      const intersects = raycaster.intersectObjects(ring.children, true);
      if (intersects.length > 0) {
        const hit = intersects[0].object;
        const projectId = hit.userData.projectId;
        const projectPdf = hit.userData.projectPdf;

        if (projectId) {
          console.log('[AR] select 點擊作品：', projectId);
          gsap.to(hit.scale, {
            x: 1.2,
            y: 1.2,
            z: 1.2,
            duration: 0.2,
            yoyo: true,
            repeat: 1,
            ease: 'power2.out'
          });
          // AR 模式目前不自動打開 PDF，以免跳視窗干擾 AR session
        }
      }
    };
    session.addEventListener('select', onXRSelect);

    // 使用 setAnimationLoop 作為 WebXR 渲染迴圈入口
    renderer.setAnimationLoop(onXRFrame);

    // 當 Session 結束時清除狀態
    session.addEventListener('end', () => {
      console.log('[AR] session end，重置 hit-test 狀態');
      hitTestSourceRequested = false;
      hitTestSource = null;
      viewerSpace = null;
      ring = null;
      hasPlacedRing = false;
      isARMode = false;
      if (reticle) {
        reticle.visible = false;
      }
      session.removeEventListener('select', onXRSelect);
    });

    // 隱藏 UI overlay（按鈕等）
    const overlay = document.getElementById('ui-overlay');
    if (overlay) overlay.style.display = 'none';

  } catch (err) {
    console.error('[AR] 無法啟動 AR Session：', err);
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
      // 每幀都要重新設定傾斜，因為 lookAt 會覆蓋
      child.rotateX(-Math.PI / 4);
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
      // 用「向下」的射線偵測地板：viewer space 的 -Y 是正下方，
      // 這樣對地時也能偵測到平面（原本朝前射線對地板常失效）
      const origin = new DOMPoint(0, 0, 0);
      const direction = new DOMPoint(0, -1, 0);
      const offsetRay = typeof XRRay !== 'undefined' ? new XRRay(origin, direction) : null;

      const opts = { space: viewerSpace };
      if (offsetRay) opts.offsetRay = offsetRay;

      session.requestHitTestSource(opts).then((source) => {
        hitTestSource = source;
      }).catch((err) => {
        // 若向下射線失敗，改回預設（朝前射線）
        session.requestHitTestSource({ space: viewerSpace }).then((src) => {
          hitTestSource = src;
        }).catch((e) => console.warn('[AR] hit-test 建立失敗', e));
      });
    }).catch((err) => {
      console.warn('[AR] 建立 hit-test source 失敗：', err);
    });
  }

  if (hitTestSource) {
    const hitTestResults = frame.getHitTestResults(hitTestSource);
    if (hitTestResults.length > 0) {
      const hit = hitTestResults[0];
      const pose = hit.getPose(referenceSpace);
      if (pose) {
        reticle.visible = true;
        reticle.matrix.fromArray(pose.transform.matrix);
      } else {
        reticle.visible = false;
      }
    } else {
      reticle.visible = false;
    }
  }

  // 取得 viewer（手機）位置，供環形跟隨
  const viewerPose = frame.getViewerPose(referenceSpace);
  if (viewerPose) {
    const p = viewerPose.transform.position;
    lastViewerPosition.set(p.x, p.y, p.z);
  }

  // 環形：以手機 (X,Z) 為中心，高度略低（AR_RING_HEIGHT），圖示繞著轉
  // 照抄桌面版：用時間驅動角度偏移，每幀更新每個圖示的位置與朝向
  if (ring) {
    ring.position.set(lastViewerPosition.x, AR_RING_HEIGHT, lastViewerPosition.z);
    const t = time * 0.0004; // 時間 → 角度偏移（與桌面版相同）
    const count = ring.children.length || 1;
    const centerWorld = ring.position.clone(); // 環心在世界座標
    ring.children.forEach((child, index) => {
      const baseAngle = (index / count) * Math.PI * 2;
      const angle = baseAngle + t;
      const x = RING_RADIUS * Math.cos(angle);
      const z = RING_RADIUS * Math.sin(angle);
      child.position.set(x, 0, z);
      child.lookAt(centerWorld);
      // 每幀都要重新設定傾斜，因為 lookAt 會覆蓋
      child.rotateX(-Math.PI / 4);
    });
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
  // 重要：環形的「中心」要放在點擊/準星位置，否則會一直出現在 AR 原點 (0,0,0) 附近
  ring.position.set(position.x, position.y, position.z);

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
    texture.flipY = false;
    // 與桌面版相同：以中心旋轉 180 度，讓圖示在你視角下正向顯示
    texture.center.set(0.5, 0.5);
    texture.rotation = Math.PI;

    const material = new THREE.MeshBasicMaterial({
      map: texture,
      transparent: true
    });

    const plane = new THREE.Mesh(geometry, material);
    // 圖示在「環形群組」的區域座標：水平圓環上，高度 0（環心在地板）
    plane.position.set(x, 0, z);
    // 讓圖示朝向環心（ring 的中心 = 你點擊放環的位置）
    plane.lookAt(ring.position);

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
  const height = 0.4; // icon 高度（降低到桌面高度附近）
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
    
    // 計算指向圓心的角度
    const angleToCenter = Math.atan2(-x, -z);
    // 用 YXZ 順序：先 Y 軸轉向，再 X 軸傾斜
    group.rotation.set(-Math.PI / 4, angleToCenter + Math.PI, 0, 'YXZ');

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
    if (!hasPlacedRing) {
      if (reticle && reticle.visible) {
        const reticlePosition = new THREE.Vector3();
        reticle.getWorldPosition(reticlePosition);
        console.log('[AR] 使用 reticle 位置放置環形：', reticlePosition);
        createProjectRing(reticlePosition);
        hasPlacedRing = true;
        return;
      }

      // 備案：若裝置沒有提供 hit-test 結果（reticle 永遠不亮），
      // 就直接在相機前方固定距離生成環形，避免完全無法互動。
      const camDir = new THREE.Vector3();
      const camPos = new THREE.Vector3();
      camera.getWorldDirection(camDir);
      camera.getWorldPosition(camPos);
      const distance = 1.5; // 公尺，環形中心距離相機的距離
      const fallbackPos = camPos.clone().add(camDir.multiplyScalar(distance));
      console.log('[AR] 無 reticle，改用相機前方位置放置環形：', fallbackPos);
      createProjectRing(fallbackPos);
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