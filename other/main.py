import requests
import json
import time

def get_all_scratch_projects(username):
    all_data = []
    base_url = f"https://api.scratch.mit.edu/users/{username}/projects"
    
    offset = 0
    limit = 40
    
    print(f"Starting to fetch all projects for: {username}")

    while True:
        params = {
            "limit": limit,
            "offset": offset
        }
        
        try:
            print(f"Fetching projects from offset {offset}...")
            response = requests.get(base_url, params=params)
            response.raise_for_status()
            
            res_data = response.json()
            
            # 取得したデータをリストに追加
            all_data.extend(res_data)
            
            # デバッグ用: 今回取得した件数
            current_count = len(res_data)
            
            # --- ここが判定のポイント ---
            # 取得したデータが limit (40) より少ない場合は、それが最後のページ
            if current_count < limit:
                break
                
            # 次のページへ（オフセットを40進める）
            offset += limit
            
            # APIへの負荷軽減
            time.sleep(0.1)
            
        except requests.exceptions.RequestException as e:
            print(f"Error occurred: {e}")
            break

    # ファイルに書き出し
    output_file = "./data.js"
    with open(output_file, "w", encoding="utf-8") as f:
        json_string = json.dumps(all_data, ensure_ascii=False)
        f.write(f"const data = {json_string}")
        
    print("-" * 30)
    print(f"Finished! Total projects: {len(all_data)}")
    print(f"Saved to: {output_file}")

if __name__ == "__main__":
    get_all_scratch_projects("horiyouta")