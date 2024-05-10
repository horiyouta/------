// 読み込み 初期化

const topPage = /** @type { HTMLParagraphElement } */ (document.getElementById(`topPage`));
const roundFile = /** @type { HTMLInputElement } */ (document.getElementById(`roundFile`));
const seaCon = /** @type { HTMLDivElement } */ (document.getElementById(`searchContent`));
const convert = /** @type { HTMLButtonElement } */ (document.getElementById(`convert`));
const mycanvas = /** @type { HTMLCanvasElement } */ (document.createElement(`canvas`));
const maxSize = /** @type { HTMLInputElement } */ (document.getElementById(`maxSize`));
const display = /** @type { HTMLDivElement } */ (document.getElementById(`display`));
const modeDivs = /** @type { HTMLCollectionOf<HTMLDivElement> } */ (display.children);
const tool = /** @type { HTMLParagraphElement } */ (document.getElementById(`tool`));
const info = /** @type { HTMLParagraphElement } */ (document.getElementById(`info`));
const input = /** @type { HTMLInputElement } */ (document.getElementById(`input`));
const video = /** @type { HTMLVideoElement } */ (document.createElement(`video`));
const sInp = /** @type { HTMLInputElement } */ (document.getElementById(`sInp`));
const ta = /** @type { HTMLTextAreaElement } */ (document.getElementById(`ta`));
const nsg = /** @type { HTMLDivElement } */ (document.getElementById(`nsg`));

// 変数

let mode = 0;

// 関数

/** 毎フレーム処理 */
const frameFunc = () => {
    for (let i = 0; i < modeDivs.length; i++) {
        modeDivs[i].style.display = (mode == i) ? `` : `none`;
    }
    requestAnimationFrame(frameFunc);
}

/** 検索結果 */
const searchResult = (word) => {
    const list = [];
    const addList = (i) => {
        const content = document.createElement(`div`);
        content.classList.add(`content`);
        const img = document.createElement(`img`);
        img.src = `https://uploads.scratch.mit.edu/get_image/project/${data[list[i]].id}_408x306.png`;
        content.appendChild(img);
        const link = document.createElement(`a`);
        link.href = `https://scratch.mit.edu/projects/${data[list[i]].id}/`;
        link.target = `_blank`;
        link.title = data[list[i]].title;
        link.textContent = data[list[i]].title;
        img.addEventListener(`click`, () => { link.click() });
        content.appendChild(link);
        seaCon.appendChild(content);
        list.splice(i, 1);
    }
    mode = 1;
    seaCon.textContent = ``;
    const today = new Date();
    const month = String(today.getMonth() + 1);
    const date = String(today.getDate());
    for (let i = 0; i < data.length; i++) {
        if (
            word == `全て` || (!word.endsWith(`年前`) && data[i].title.includes(word)) ||
            (word.endsWith(`年前`) && data[i].history.shared.includes(`${today.getFullYear() - Number(word[0])}-${month.slice(month.length - 2, month.length)}-${date.slice(date.length - 2, date.length)}`))
        ) list.push(i);
    }
    while (0 < list.length) {
        if (list.length == 1) addList(0);
        else {
            let max = 0;
            for (let i = 1; i < list.length; i++) {
                if (data[list[max]].stats.views < data[list[i]].stats.views) max = i;
            }
            addList(max);
        }
    }
}

const convertRound = () => {
    if (0 < roundFile.files.length) {
        const fileReader = new FileReader();
        fileReader.addEventListener(`load`, () => {
            const svg = document.createElement(`a`);
            svg.href = URL.createObjectURL(new Blob([fileReader.result.replace(/(?<=stroke\-linejoin\=\").*?(?=\")/g, `round`)], { type: `svg/image` }));
            svg.download = roundFile.files[0].name;
            svg.click();
        });
        fileReader.readAsText(roundFile.files[0])
    }
}

const changeInput = () => {
    video.src = URL.createObjectURL(new Blob([input.files[0]], { type: `video/mp4` }));
    video.addEventListener(`loadeddata`, () => {
        if (video.videoHeight < video.videoWidth) {
            mycanvas.width = maxSize.value;
            mycanvas.height = video.videoHeight * maxSize.value / video.videoWidth;
        } else {
            mycanvas.width = video.videoWidth * maxSize.value / video.videoHeight;
            mycanvas.height = maxSize.value;
        }
        const ctx = /** @type { CanvasRenderingContext2D } */ (mycanvas.getContext(`2d`));
        let text = `${mycanvas.width}/${mycanvas.height}/`;
        ta.value = `変換中...`;
        const func = () => {
            ctx.drawImage(video, 0, 0, mycanvas.width, mycanvas.height);
            const imageData = ctx.getImageData(0, 0, mycanvas.width, mycanvas.height).data;
            for (let i = 0; i < imageData.length; i += 4) {
                text += imageData[i].toString(16).padStart(2, `0`) + imageData[i + 1].toString(16).padStart(2, `0`) + imageData[i + 2].toString(16).padStart(2, `0`);
            }
            if (!video.paused) setTimeout(func, 1000 / 15);
            else ta.value = text;
        }
        video.play();
        func();
    });
}

// 全体処理

frameFunc();

addEventListener(`keydown`, (event) => { if (event.key == `Enter` && sInp.value != ``) searchResult(sInp.value) });
nsg.addEventListener(`click`, () => { if (sInp.value != ``) searchResult(sInp.value) });
topPage.addEventListener(`click`, () => { mode = 0 });
tool.addEventListener(`click`, () => { mode = 2 });
info.addEventListener(`click`, () => { mode = 3 });
convert.addEventListener(`click`, convertRound);
input.addEventListener(`change`, changeInput);