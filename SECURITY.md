# 보안 안내

이 프로젝트를 공개 GitHub Pages로 배포하기 전에 다음을 확인하세요.

1. 관리자 비밀번호를 HTML 또는 JavaScript에 직접 넣지 않습니다.
2. Firebase Realtime Database 규칙에서 익명 읽기·쓰기를 허용하지 않습니다.
3. 관리자 작업은 Firebase Authentication 사용자에게만 허용합니다.
4. 회원 이름, 점수, 회비 및 벌금 정보의 공개 동의를 확인합니다.
5. Claude API 키 같은 비밀 키는 브라우저 코드나 GitHub 저장소에 저장하지 않습니다.

클라이언트 화면에서 버튼을 숨기는 것만으로는 데이터베이스를 보호할 수 없습니다.
