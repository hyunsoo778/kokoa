# LANE LAB 무료 배포

## 가장 쉬운 방법: Netlify Drop

1. `lane-lab-deploy.zip` 파일의 압축을 풉니다.
2. [Netlify Drop](https://app.netlify.com/drop)에 접속합니다.
3. 압축을 푼 `lane-lab-deploy` 폴더를 화면에 끌어다 놓습니다.
4. 생성된 `https://...netlify.app` 주소를 휴대폰에서 엽니다.
5. 카메라 권한을 허용합니다.

Netlify 무료 계정으로 로그인하면 사이트 주소 변경과 재배포가 가능합니다.

## Vercel

GitHub 저장소에 이 폴더를 올리고 Vercel에서 프로젝트를 가져옵니다.
저장소 전체를 연결할 경우 `Root Directory`를 `bowling-ai`로 설정합니다.
빌드 명령은 비워 두고 Output Directory는 `.`을 사용합니다.

## GitHub Pages

이 폴더의 파일을 Pages용 저장소 최상단에 업로드한 뒤 저장소의
`Settings > Pages > Deploy from a branch`에서 브랜치를 선택합니다.

## 휴대폰 설치

- Android Chrome: 메뉴 → `홈 화면에 추가` 또는 `앱 설치`
- iPhone Safari: 공유 버튼 → `홈 화면에 추가`

카메라는 HTTPS로 배포된 주소에서만 정상적으로 사용할 수 있습니다.

처음 카메라 분석을 실행할 때 Google MediaPipe 자세 모델을 내려받으므로
인터넷 연결이 필요합니다. 모델 준비가 끝나면 화면 상단에 `AI 준비됨`이 표시됩니다.

패턴표 이미지 자동 분석은 브라우저에서 OCR 모델을 처음 한 번 내려받습니다.
패턴표의 제목, 길이, 총 오일량을 읽고 Rule of 31 기준 추천 라인을 자동 적용합니다.
