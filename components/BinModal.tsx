"use client";

export default function BinModal() {
  return (
    <div
      className="modalBack binModalBack"
      id="modalBack"
      style={{ display: "none" }}
    >
      <div className="modal binModalCompact">
        <div className="binModalHead">
          <div className="binHeadText">
            <div className="binModalTitle" id="mTitle">
              Hudud
            </div>
            <div className="binModalSub">
              To‘ldirilish holati va batafsil ma’lumot
            </div>
          </div>

          <button
            className="iconBtn iconBtnSm binCloseBtn"
            id="mClose"
            type="button"
          >
            ✕
          </button>
        </div>

        <div className="binModalBody">
          <div className="binMediaCol">
            <div className="binMainImageWrap">
              <img
                id="mMainImg"
                alt="Hudud rasmi"
                src="/bin-placeholder.jpg"
              />

              <div className="binTopBadges">
                <span className="badge" id="mBadgeStatus">
                  —
                </span>
                <span className="badge soft" id="mBadgeFill">
                  —
                </span>
              </div>
            </div>

            <div className="thumbRow compactThumbs" id="mThumbs"></div>
          </div>

          <div className="binInfoCol">
            <div className="binInfoGrid">
              <div className="binInfoCard">
                <div className="l">Yangilangan</div>
                <div className="v" id="mUpd">
                  —
                </div>
              </div>
            </div>

            {/* JS uchun yashirin elementlar */}
            <span id="mStatus" style={{ display: "none" }} />
            <span id="mFill" style={{ display: "none" }} />
            <span id="mCoord" style={{ display: "none" }} />

            <div className="binActionRow">
              <button className="btn binBtn primary" id="mFocus" type="button">
                Haritada ko’rsat
              </button>

              <button
                className="btn binBtn danger"
                id="cleanBtn"
                type="button"
                style={{ display: "none" }}
              >
                Tozalash
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}