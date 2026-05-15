# VS Code Marketplace publish 가이드 (한글)

`tierkit-vscode` 확장을 [marketplace.visualstudio.com](https://marketplace.visualstudio.com)에 올리는 방법.

> 이 문서는 *처음 publish*까지 가는 가장 짧은 경로만 다룹니다. 이후 버전 업은 §6을 참고하세요.

---

## 현재 상태

✅ 이미 준비된 것 (코드 레벨)
- `package.json` 마켓플레이스 필드 (`displayName`, `categories`, `keywords`, `repository`, `bugs`, `homepage`, `icon`, `engines.vscode`)
- `media/tierkit.svg` — 사이드바 activity bar 아이콘
- `icon.png` (128×128 placeholder, SVG에서 변환됨) — 마켓플레이스 카드 아이콘
- `LICENSE`, `CHANGELOG.md`, `README.md`
- `.vscodeignore` (dist + media + readme + license + icon만 포함)
- `prepublish:check` npm script (publisher placeholder / icon 누락 fail-fast)
- `package` / `publish:vsix` npm scripts
- `.github/workflows/publish-vscode.yml` — `vsix-*` 태그 push 시 자동 publish (CI에서 PAT secret 사용)

⚠️ **사용자만 할 수 있는 3가지** — 아직 안 끝남
- ① Microsoft 계정으로 Publisher 생성
- ② Azure DevOps에서 Personal Access Token 발급
- ③ `package.json::publisher` 값 교체

선택사항
- ④ 본인 디자인의 128×128 PNG로 `icon.png` 교체 (현재는 SVG 기반 placeholder)

---

## ① Publisher 생성 (Microsoft 계정 필요, 5분)

1. https://marketplace.visualstudio.com/manage 접속 → Microsoft 계정 로그인
2. **Create publisher** 클릭
3. 입력:
   - **ID**: 소문자 + 하이픈만, 한 번 만들면 변경 불가. 추천 `leesiwal` 또는 짧고 안 겹치는 이름
   - **Name**: display name (나중에 변경 가능)
   - **Email**: 본인 (공개 안 됨)
4. 저장

> Publisher ID는 마켓플레이스에서 `<publisher>.<extension>` 형식의 fully-qualified 이름 일부가 됩니다. 예: `leesiwal.tierkit-vscode`.

---

## ② Personal Access Token 발급 (5분)

1. https://dev.azure.com 접속 → Microsoft 계정 로그인 (Publisher와 같은 계정)
   - "Get started" 누르고 organization 하나 만들라고 하면 만드세요 — 이름은 아무거나
2. 우상단 사용자 아이콘 → **Personal access tokens**
3. **+ New Token**:
   - **Name**: `tierkit-vscode-publish`
   - **Organization**: **All accessible organizations** (드롭다운)
   - **Expiration**: 90일 권장 (만료되면 새로 발급)
   - **Scopes**: **Custom defined** 선택 → 스크롤 → **Marketplace** → ☑ **Manage** 체크
4. **Create** → **토큰 문자열은 이 화면을 닫으면 다시 못 봄**. 안전한 곳에 복사
5. shell에 export (선택):
   ```sh
   echo 'export VSCE_PAT="<paste-here>"' >> ~/.zshrc
   source ~/.zshrc
   ```

---

## ③ package.json publisher 교체

```sh
cd /Users/siwal/code/Tierkit/packages/vscode-tierkit
```

`package.json` 8번째 줄:
```diff
-  "publisher": "tierkit-placeholder",
+  "publisher": "<여기에-본인-publisher-id>",
```

또는 한 줄로 (BSD/macOS sed):
```sh
sed -i '' 's/"publisher": "tierkit-placeholder"/"publisher": "<여기에-본인-publisher-id>"/' package.json
```

확인:
```sh
pnpm run prepublish:check
# → prepublish check ok: publisher=<your-id>, icon=icon.png present
```

---

## ④ (선택) 본인 디자인 아이콘으로 교체

현재 `icon.png`은 SVG에서 qlmanage로 뽑은 placeholder입니다. 마켓플레이스 카드에 좀 더 보기 좋은 아이콘을 쓰고 싶다면:

- Figma / Pixelmator / Photoshop 등에서 128×128 PNG 디자인
- `packages/vscode-tierkit/icon.png`에 덮어쓰기
- 알파 채널 OK, 배경 투명 권장

좀 더 세련된 일러스트가 필요하면 SVG (`media/tierkit.svg`)를 손보고 다시 변환:
```sh
qlmanage -t -s 512 -o /tmp/ media/tierkit.svg && \
  sips -z 128 128 /tmp/tierkit.svg.png --out icon.png
```

---

## ⑤ Publish — 두 가지 방법

### A. 로컬 한 줄 (가장 간단)

```sh
cd /Users/siwal/code/Tierkit/packages/vscode-tierkit

# 1) 빌드 (모노레포 루트에서)
cd /Users/siwal/code/Tierkit && pnpm -r build
cd packages/vscode-tierkit

# 2) (한 번만) PAT 등록 — 인터랙티브
pnpm exec vsce login <your-publisher-id>
# Personal Access Token: <붙여넣기>

# 3) 마켓플레이스로 publish
pnpm run publish:vsix
# 또는: VSCE_PAT="..." pnpm run publish:vsix  (login 생략, 1회용)
```

성공 출력 예시:
```
Publishing <publisher>.tierkit-vscode@0.1.0...
Extension URL (might take a few minutes until it's available):
https://marketplace.visualstudio.com/items?itemName=<publisher>.tierkit-vscode
DONE  Published <publisher>.tierkit-vscode v0.1.0.
```

마켓플레이스 인덱싱에 보통 5-10분 정도. 그 사이 위 URL은 404 떴다가 나타납니다.

### B. GitHub Actions로 태그 push 자동 publish (반복 publish용)

이미 `.github/workflows/publish-vscode.yml`이 들어가 있습니다.

준비 (한 번만):
1. GitHub 저장소 (`LeeSiWal/Tierkit`) → **Settings** → **Secrets and variables** → **Actions** → **New repository secret**
   - Name: `VSCE_PAT`
   - Value: 위 ②에서 발급한 토큰
2. publisher id 변경 commit + push

이후 publish는 한 줄:
```sh
cd /Users/siwal/code/Tierkit
git tag vsix-0.1.0
git push origin vsix-0.1.0
# → GitHub Actions가 자동으로:
#   - pnpm install + build
#   - prepublish:check
#   - vsce package
#   - .vsix artifact 업로드
#   - vsce publish (VSCE_PAT secret 사용)
```

워크플로 진행상황: `Actions` 탭에서 확인.

수동 dry-run (publish 없이 .vsix만 생성):
- Actions → **Publish VS Code Extension** → **Run workflow** → `dry-run` ☑

---

## ⑥ 버전 업데이트 (publish 후)

마켓플레이스는 같은 `<publisher>.<name>@<version>`를 두 번 publish 못 받습니다. 새 버전:

```sh
cd /Users/siwal/code/Tierkit/packages/vscode-tierkit

# patch / minor / major
pnpm exec vsce package --no-dependencies          # 또는 packaging만
# package.json::version은 직접 수정하거나 npm version patch

# 수동:
# 1) package.json::version 0.1.0 → 0.1.1
# 2) CHANGELOG.md에 새 섹션 추가
# 3) commit + tag + push:
git add -A && git commit -m "tierkit-vscode 0.1.1"
git tag vsix-0.1.1 && git push origin main vsix-0.1.1
# → Actions가 새 버전을 자동 publish
```

또는 로컬에서:
```sh
pnpm run publish:vsix
```

---

## ⑦ Unpublish / 버전 회수

마켓플레이스 정책상 publish 후 unpublish는 가능하지만 비추천 (다운로드 사용자에게 영향).

**버전만 회수**:
```sh
vsce unpublish <publisher>.tierkit-vscode 0.1.0
```

**확장 자체 unpublish** (publisher만 가능):
```sh
vsce unpublish <publisher>.tierkit-vscode
```

심각한 버그가 있다면 unpublish보다 **빠르게 patch 버전을 새로 publish**하는 게 보통 더 좋습니다.

---

## ⑧ 자주 마주치는 문제

### `ERROR Missing publisher name. Learn more...`
→ `package.json::publisher` 값이 비어있거나 placeholder. ③번 단계 확인.

### `ERROR The Personal Access Token verification has failed`
→ PAT가 만료됐거나 Scope에 Marketplace > Manage가 없음. ②번 재발급.

### `ERROR Make sure to edit the README.md file before you publish your extension.`
→ vsce는 README가 vsce 기본 템플릿 그대로면 거절. 우리 README는 이미 잘 작성돼 있으니 보통 안 뜸. 만약 뜨면 README 첫 줄을 수정.

### `ERROR Invalid extension publisher name 'tierkit-placeholder'`
→ 그래도 placeholder가 남아있음. ③번 단계 빠뜨림.

### `ERROR The extension 'tierkit-vscode' already exists in the Marketplace`
→ 다른 publisher가 같은 이름을 먼저 차지했거나, 본인 publisher가 이전에 publish한 것. `<publisher>.<name>` 조합이 unique해야 함. `package.json::name`을 좀 더 specific하게 (예: `tierkit-vscode-companion`).

### Actions workflow가 안 돌아감
→ 태그 형식이 정확히 `vsix-*`인지 확인 (`vsix-0.1.0` ✓, `v0.1.0` ✗). 또는 `secrets.VSCE_PAT`가 등록 안 됨.

---

## ⑨ 마켓플레이스 페이지 꾸미기 (publish 후)

publish 후 마켓플레이스 페이지에서 추가로 설정 가능 (Microsoft 계정 publisher 관리에서):
- Gallery flags (Preview 배지 등)
- Q & A 활성화 여부
- Categories / tags 변경

README가 페이지에 그대로 렌더되니, screenshot/GIF 추가하면 conversion 좋아짐:
```md
![Tierkit sidebar](docs/screenshot-sidebar.png)
```
이미지는 GitHub raw URL을 쓰면 가장 안전 (`https://raw.githubusercontent.com/LeeSiWal/Tierkit/main/...`).

---

## 한눈에 보는 체크리스트

```
[ ] Publisher 생성 (marketplace.visualstudio.com)
[ ] PAT 발급 (dev.azure.com, Marketplace > Manage scope)
[ ] package.json::publisher 교체
[ ] (선택) icon.png 본인 디자인으로 교체
[ ] pnpm run prepublish:check 통과 확인
[ ] pnpm exec vsce login <publisher>
[ ] pnpm run publish:vsix
[ ] marketplace.visualstudio.com/items?itemName=<publisher>.tierkit-vscode 5-10분 후 확인
[ ] (선택) GitHub repo Settings → Secrets → VSCE_PAT 등록
[ ] (선택) git tag vsix-0.1.0 && git push origin vsix-0.1.0
```
